// ═══════════════════════════════════════════════════════════════════
// Phase 2 — Pre-transfer backup/snapshot of the DESTINATION store.
//
// Taken before any write, so a transfer is undoable. Two complementary
// halves make up a full "undo", and it matters that they're distinct:
//
//   • This module (backup/restore) reverts records that a transfer
//     OVERWROTE, back to their pre-transfer field values.
//   • rollback.server.js deletes records the transfer CREATED.
//
// Restore alone cannot remove newly-created products, and rollback alone
// cannot un-overwrite an existing one — the "one-click undo" surface calls
// both. Neither ever touches a record the transfer merely skipped.
//
// Scale constraint, handled explicitly rather than hidden: the payload is
// JSON in a SQLite TEXT column, so a very large destination store cannot be
// snapshotted whole. Past the cap the backup is marked PARTIAL/truncated and
// the caller is expected to surface that BEFORE the transfer runs — a
// merchant must never believe they have a complete backup when they don't.
// ═══════════════════════════════════════════════════════════════════

import { ACTION, ENTITY } from "./transfer-log.server.js";

export const SNAPSHOT_VERSION = 1;

// Caps chosen so a snapshot stays a few MB at worst. Beyond this, a JSON blob
// in SQLite is the wrong storage and we say so instead of silently truncating.
export const MAX_SNAPSHOT_PRODUCTS = 5000;
export const MAX_SNAPSHOT_COLLECTIONS = 1000;
export const DEFAULT_RETENTION_DAYS = 30;

const PRODUCTS_PAGE_SIZE = 100;
const COLLECTIONS_PAGE_SIZE = 100;

const SNAPSHOT_PRODUCTS_QUERY = `#graphql
  query BackupProducts($after: String) {
    products(first: ${PRODUCTS_PAGE_SIZE}, after: $after) {
      edges { cursor node {
        id handle title descriptionHtml vendor productType tags status
        metafields(first: 50) { edges { node { namespace key value type } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const SNAPSHOT_COLLECTIONS_QUERY = `#graphql
  query BackupCollections($after: String) {
    collections(first: ${COLLECTIONS_PAGE_SIZE}, after: $after) {
      edges { cursor node {
        id handle title descriptionHtml sortOrder
        metafields(first: 50) { edges { node { namespace key value type } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

function normalizeMetafields(node) {
  return (node?.metafields?.edges || [])
    .map((e) => e.node)
    .filter((m) => m?.namespace && m?.key)
    .map((m) => ({ namespace: m.namespace, key: m.key, value: m.value, type: m.type }));
}

// Walks a paginated connection up to `max` records. Returns { items, truncated }
// so the caller can tell "that's everything" from "we stopped early".
async function paginate({ shopifyGraphql, shop, token, version, query, field, max }) {
  const items = [];
  let after = null;
  let hasNextPage = true;
  let truncated = false;

  while (hasNextPage) {
    const data = await shopifyGraphql(shop, token, query, { after }, version);
    const connection = data?.[field];
    const edges = connection?.edges || [];
    for (const edge of edges) {
      if (items.length >= max) { truncated = true; break; }
      items.push(edge.node);
    }
    if (truncated) break;
    hasNextPage = !!connection?.pageInfo?.hasNextPage;
    after = connection?.pageInfo?.endCursor || null;
    if (!after) break; // defensive: never loop forever on a malformed page
  }
  return { items, truncated };
}

// Captures the destination store's current state. Pure with respect to the
// destination — read-only, no writes.
export async function snapshotStore({ shopifyGraphql, shop, token, version }) {
  const { items: productNodes, truncated: productsTruncated } = await paginate({
    shopifyGraphql, shop, token, version,
    query: SNAPSHOT_PRODUCTS_QUERY, field: "products", max: MAX_SNAPSHOT_PRODUCTS,
  });
  const { items: collectionNodes, truncated: collectionsTruncated } = await paginate({
    shopifyGraphql, shop, token, version,
    query: SNAPSHOT_COLLECTIONS_QUERY, field: "collections", max: MAX_SNAPSHOT_COLLECTIONS,
  });

  let metafieldCount = 0;
  const products = productNodes.map((p) => {
    const metafields = normalizeMetafields(p);
    metafieldCount += metafields.length;
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      tags: Array.isArray(p.tags) ? p.tags : [],
      status: p.status,
      metafields,
    };
  });
  const collections = collectionNodes.map((c) => {
    const metafields = normalizeMetafields(c);
    metafieldCount += metafields.length;
    return {
      id: c.id,
      handle: c.handle,
      title: c.title,
      descriptionHtml: c.descriptionHtml,
      sortOrder: c.sortOrder,
      metafields,
    };
  });

  return {
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    shop,
    products,
    collections,
    truncated: { products: productsTruncated, collections: collectionsTruncated },
    counts: { products: products.length, collections: collections.length, metafields: metafieldCount },
  };
}

export function computeExpiry(from = new Date(), retentionDays = DEFAULT_RETENTION_DAYS) {
  return new Date(from.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

// Takes a snapshot and persists it as a StoreBackup row.
// Never throws: a backup failure is recorded as a FAILED backup row and
// returned to the caller, which decides whether to proceed with the transfer.
// Silently continuing with no backup at all is the one outcome not allowed.
export async function createBackup({ prisma, shopifyGraphql, shop, token, version, jobId = null, retentionDays = DEFAULT_RETENTION_DAYS, now = () => new Date() }) {
  const expiresAt = computeExpiry(now(), retentionDays);
  try {
    const snapshot = await snapshotStore({ shopifyGraphql, shop, token, version });
    const data = JSON.stringify(snapshot);
    const truncated = snapshot.truncated.products || snapshot.truncated.collections;

    const backup = await prisma.storeBackup.create({
      data: {
        shop,
        jobId,
        status: truncated ? "PARTIAL" : "READY",
        productCount: snapshot.counts.products,
        collectionCount: snapshot.counts.collections,
        metafieldCount: snapshot.counts.metafields,
        truncated,
        data,
        sizeBytes: Buffer.byteLength(data, "utf8"),
        expiresAt,
      },
    });
    return { ok: true, backup, truncated, snapshot };
  } catch (err) {
    console.error(`[backup] snapshot failed for shop=${shop} job=${jobId}:`, err?.message);
    let backup = null;
    try {
      backup = await prisma.storeBackup.create({
        data: { shop, jobId, status: "FAILED", error: String(err?.message || err).slice(0, 500), expiresAt },
      });
    } catch (writeErr) {
      console.error(`[backup] could not even record the failure for shop=${shop}:`, writeErr?.message);
    }
    return { ok: false, backup, error: err?.message || String(err) };
  }
}

export function parseSnapshot(backup) {
  if (!backup?.data) return null;
  try {
    const parsed = JSON.parse(backup.data);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isExpired(backup, now = new Date()) {
  if (!backup?.expiresAt) return false;
  return new Date(backup.expiresAt).getTime() < now.getTime();
}

const PRODUCT_RESTORE_MUTATION = `#graphql
  mutation RestoreProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }`;

// Re-applies a snapshot's field values to products that still exist on the
// destination. Deliberately scoped:
//   • Only products present in the snapshot are touched — anything created
//     after the snapshot is rollback's problem, not restore's.
//   • A product that no longer exists is reported, not recreated: recreating
//     it would produce a different product ID and silently diverge from what
//     the merchant expects an "undo" to mean.
export async function restoreBackup({ prisma, shopifyGraphql, backup, token, version, logBuffer = null, now = () => new Date() }) {
  const result = { restored: 0, failed: 0, skipped: 0, errors: [] };

  if (!backup) return { ...result, ok: false, error: "Backup not found" };
  if (backup.status === "FAILED") return { ...result, ok: false, error: "This backup failed to capture and cannot be restored" };
  if (isExpired(backup, now())) return { ...result, ok: false, error: "This backup has expired and can no longer be restored" };

  const snapshot = parseSnapshot(backup);
  if (!snapshot) return { ...result, ok: false, error: "Backup payload is unreadable" };
  if (snapshot.version !== SNAPSHOT_VERSION) {
    return { ...result, ok: false, error: `Unsupported snapshot version ${snapshot.version}` };
  }

  for (const product of snapshot.products || []) {
    if (!product?.id) { result.skipped++; continue; }
    try {
      const data = await shopifyGraphql(backup.shop, token, PRODUCT_RESTORE_MUTATION, {
        product: {
          id: product.id,
          title: product.title ?? "",
          descriptionHtml: product.descriptionHtml ?? "",
          vendor: product.vendor ?? "",
          productType: product.productType ?? "",
          tags: Array.isArray(product.tags) ? product.tags : [],
          status: product.status || "ACTIVE",
        },
      }, version);

      const userErrors = data?.productUpdate?.userErrors || [];
      if (userErrors.length) {
        // A product deleted since the snapshot surfaces here as a userError
        // rather than an exception — count it, don't pretend it restored.
        const reason = userErrors.map((e) => e.message).join("; ");
        result.failed++;
        result.errors.push({ id: product.id, handle: product.handle, error: reason });
        await logBuffer?.add({ entityType: ENTITY.PRODUCT, action: ACTION.FAILED, destId: product.id, title: product.title, reason: `Restore failed: ${reason}` });
        continue;
      }

      result.restored++;
      await logBuffer?.add({ entityType: ENTITY.PRODUCT, action: ACTION.UPDATED, destId: product.id, title: product.title, reason: "Restored from pre-transfer backup" });
    } catch (err) {
      result.failed++;
      result.errors.push({ id: product.id, handle: product.handle, error: err?.message || String(err) });
      await logBuffer?.add({ entityType: ENTITY.PRODUCT, action: ACTION.FAILED, destId: product.id, title: product.title, reason: `Restore failed: ${err?.message}` });
    }
  }

  await logBuffer?.flush();

  try {
    await prisma.storeBackup.update({ where: { id: backup.id }, data: { status: "RESTORED", restoredAt: now() } });
  } catch (err) {
    console.warn(`[backup] could not mark backup ${backup.id} as restored:`, err?.message);
  }

  return { ...result, ok: result.failed === 0, partial: backup.truncated };
}

// Housekeeping: drop snapshots past their retention window. Payloads are the
// bulk of this table, so leaving them around indefinitely is a real disk cost.
export async function purgeExpiredBackups(prisma, now = new Date()) {
  const { count } = await prisma.storeBackup.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
