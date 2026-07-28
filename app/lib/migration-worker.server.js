// Background product-migration worker.
// Runs as a fire-and-forget Promise inside the Node.js process — fully decoupled
// from the HTTP request that created the MigrationJob. On process restart PM2
// brings the app back; the status endpoint auto-resumes any RUNNING job.

import prisma from "../db.server.js";
import { encrypt, decrypt } from "../utils/encryption.server.js";
import { shopifyGraphql } from "./shopify-api.server.js";
import { createProductWithVariants } from "./product-variants.server.js";
import { createLogBuffer, ACTION, ENTITY } from "./transfer-log.server.js";
import { createBackup } from "./backup.server.js";

const BATCH_SIZE = 250;     // products fetched per GQL page
const CREATE_CONCURRENCY = 5; // parallel productCreate calls
const CHECKPOINT_EVERY = 50; // write progress to DB every N products

// ── Module-level registry — tracks running workers so status endpoint can
//    detect and restart them if the process was killed mid-job ────────────────
/** @type {Map<string, { startedAt: number, running: boolean }>} */
const activeWorkers = new Map();
export function isWorkerActive(jobId) { return activeWorkers.has(jobId); }

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// shopifyFetch/shopifyGraphql (429 backoff + cost-throttle awareness) now
// live in shopify-api.server.js — shared with app.transfer.jsx and
// app.export.jsx instead of three independently-drifting copies.

function mediaTypeFromUrl(url = "") {
  const s = String(url).split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(s)) return "IMAGE";
  if (/\.(mp4|mov|m4v|webm)$/.test(s)) return "VIDEO";
  if (/\.(glb|usdz)$/.test(s)) return "MODEL_3D";
  return "FILE";
}

// ────────────────────────────────────────────────────────────────────────────
// Product helpers (mirror of app.transfer.jsx, kept in sync manually)
// ────────────────────────────────────────────────────────────────────────────

async function uploadImages(targetShop, targetToken, productGid, images, version) {
  const valid = (images || []).filter((i) => i.src && /^https?:\/\//i.test(i.src)).slice(0, 250);
  if (!valid.length) return;
  const mutation = `#graphql
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id }
        mediaUserErrors { field message }
      }
    }`;
  for (let i = 0; i < valid.length; i += 20) {
    const batch = valid.slice(i, i + 20).map((img) => ({
      originalSource: img.src, mediaContentType: "IMAGE", alt: img.alt || undefined,
    }));
    try {
      await shopifyGraphql(targetShop, targetToken, mutation, { productId: productGid, media: batch }, version);
    } catch (err) {
      console.warn(`[migration-worker] image batch failed for ${productGid}:`, err.message);
    }
    if (i + 20 < valid.length) await sleep(400);
  }
}

async function fetchSourceNonImageMedia(sourceShop, sourceToken, productId, version) {
  const query = `#graphql
    query ProductMedia($id: ID!) {
      product(id: $id) {
        media(first: 100) {
          nodes {
            mediaContentType alt
            ... on Video { sources { url mimeType } }
            ... on ExternalVideo { originUrl }
            ... on Model3d { sources { url mimeType } }
          }
        }
      }
    }`;
  try {
    const data = await shopifyGraphql(sourceShop, sourceToken, query, { id: `gid://shopify/Product/${productId}` }, version);
    return (data?.product?.media?.nodes || [])
      .filter((m) => m.mediaContentType && m.mediaContentType !== "IMAGE")
      .map((m) => {
        if (m.mediaContentType === "EXTERNAL_VIDEO" && m.originUrl)
          return { mediaContentType: "EXTERNAL_VIDEO", originalSource: m.originUrl, alt: m.alt || "" };
        const src = (m.sources || []).find((s) => s.url && /^https?:\/\//i.test(s.url));
        if (!src) return null;
        return { mediaContentType: m.mediaContentType, originalSource: src.url, alt: m.alt || "" };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[migration-worker] non-image media fetch failed for ${productId}:`, err.message);
    return [];
  }
}

async function uploadNonImageMedia(targetShop, targetToken, productGid, media, version) {
  if (!media.length) return;
  const mutation = `#graphql
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id }
        mediaUserErrors { field message }
      }
    }`;
  for (let i = 0; i < media.length; i += 20) {
    try {
      await shopifyGraphql(targetShop, targetToken, mutation, { productId: productGid, media: media.slice(i, i + 20) }, version);
    } catch (err) {
      console.warn(`[migration-worker] non-image media upload failed for ${productGid}:`, err.message);
    }
    if (i + 20 < media.length) await sleep(500);
  }
}

// Returns { copied, errors }. `errors` entries are { error, payload } — never
// thrown, since a metafield-copy failure must not fail the whole product
// transfer — but every entry is returned to the caller so it can be persisted
// (see runMigrationWorker) instead of only reaching a console.warn that
// nobody can retrieve after the fact.
async function copyMetafields(sourceShop, sourceToken, targetShop, targetToken, sourceGid, targetGid, version) {
  // Derive resource type from GID (e.g. gid://shopify/Product/123 → "product").
  // Bug fix: index 3 is the type segment; index 4 is the numeric ID
  // ("gid:","","shopify","Product","123") — the off-by-one meant this built
  // an invalid query field (the numeric ID itself), so metafield copying
  // silently failed on every product and was swallowed by the catch below.
  const resourceType = (sourceGid.split("/")[3] || "Product").toLowerCase();
  const query = `#graphql
    query Metafields($id: ID!) {
      ${resourceType}(id: $id) {
        metafields(first: 250) { edges { node { namespace key value type } } }
      }
    }`;
  const errors = [];
  let copied = 0;
  try {
    const data = await shopifyGraphql(sourceShop, sourceToken, query, { id: sourceGid }, version);
    const mfs = (data?.[resourceType]?.metafields?.edges || []).map((e) => e.node);
    if (!mfs.length) return { copied, errors };
    const mutation = `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { namespace key }
          userErrors { field message code }
        }
      }`;
    for (let i = 0; i < mfs.length; i += 25) {
      const batch = mfs.slice(i, i + 25)
        .filter((mf) => mf?.namespace && mf?.key && mf.value !== undefined)
        .map((mf) => ({
          ownerId: targetGid,
          namespace: mf.namespace,
          key: mf.key,
          value: typeof mf.value === "string" ? mf.value : JSON.stringify(mf.value),
          type: mf.type,
        }));
      if (!batch.length) continue;
      // Truncated payload snapshot for debugging — capped so a huge metafield
      // value (e.g. rich-text JSON) can't blow up the persisted error log.
      const payload = batch.map((b) => ({ namespace: b.namespace, key: b.key, type: b.type, value: String(b.value).slice(0, 200) }));
      try {
        const result = await shopifyGraphql(targetShop, targetToken, mutation, { metafields: batch }, version);
        // Bug fix: this call's result was previously discarded entirely — a
        // 200 OK response with a non-empty userErrors array (e.g. Shopify
        // rejecting a value/type as invalid) was silently treated as success
        // because shopifyGraphql only throws on HTTP/GraphQL-protocol errors,
        // never on mutation-level userErrors. That meant a metafield could
        // fail to copy with literally no error anywhere, not even a log line.
        const set = result?.metafieldsSet?.metafields || [];
        const userErrors = result?.metafieldsSet?.userErrors || [];
        copied += set.length;
        if (userErrors.length) {
          const detail = userErrors.map((e) => `${e.field ? e.field.join(".") + ": " : ""}${e.message}${e.code ? ` [${e.code}]` : ""}`).join("; ");
          console.warn(`[migration-worker] metafieldsSet userErrors for ${targetGid}:`, detail);
          errors.push({ error: `metafieldsSet rejected: ${detail}`, payload });
        }
      } catch (err) {
        console.warn(`[migration-worker] metafields batch failed for ${targetGid}:`, err.message);
        errors.push({ error: err.message, payload });
      }
    }
  } catch (err) {
    console.warn(`[migration-worker] copyMetafields failed for ${targetGid}:`, err.message);
    errors.push({ error: `copyMetafields fetch failed: ${err.message}` });
  }
  return { copied, errors };
}

async function findProductByHandle(targetShop, targetToken, handle, version) {
  if (!handle) return null;
  try {
    const data = await shopifyGraphql(targetShop, targetToken, `#graphql
      query FindProduct($query: String!) {
        products(first: 1, query: $query) { edges { node { id handle } } }
      }`, { query: `handle:${handle}` }, version);
    return data?.products?.edges?.[0]?.node || null;
  } catch { return null; }
}

// Creates (or skips/overwrites based on conflictMode) a single product on the destination.
// Returns { id, gid, action, metafieldErrors } of the destination product.
//
// `action` is "created" | "updated" | "skipped" and is load-bearing beyond
// logging: rollback uses it to know which destination products this app
// actually created, so an "skipped" product (one that already existed on the
// destination and is the merchant's own data) is never deleted by an undo.
async function transferOneProduct(src, ctx) {
  const { targetShop, targetToken, sourceShop, sourceToken, version, conflictMode } = ctx;
  const srcId = src.id?.split("/").pop();

  if (src.isGiftCard || src.giftCard || src.gift_card) throw new Error("Gift card products cannot be transferred");

  // Conflict detection
  if (src.handle && conflictMode !== "create") {
    const existing = await findProductByHandle(targetShop, targetToken, src.handle, version);
    if (existing) {
      if (conflictMode === "skip") return { id: existing.id.split("/").pop(), gid: existing.id, skipped: true, action: "skipped", reason: "A product with this handle already exists on the destination" };
      if (conflictMode === "overwrite") {
        const tags = Array.isArray(src.tags) ? src.tags : (typeof src.tags === "string" ? src.tags.split(",").map((t) => t.trim()).filter(Boolean) : []);
        const data = await shopifyGraphql(targetShop, targetToken, `#graphql
          mutation ProductUpdate($input: ProductInput!) {
            productUpdate(input: $input) { product { id } userErrors { field message } }
          }`, {
          input: {
            id: existing.id,
            title: src.title || "Untitled",
            descriptionHtml: src.descriptionHtml || src.body_html || "",
            vendor: src.vendor || "",
            productType: src.productType || src.product_type || "",
            tags,
          },
        }, version);
        const errs = data?.productUpdate?.userErrors || [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
        const updated = data?.productUpdate?.product;
        if (!updated) throw new Error("productUpdate returned no product");
        return { id: updated.id.split("/").pop(), gid: updated.id, action: "updated" };
      }
    }
  }

  const tags = Array.isArray(src.tags) ? src.tags : (typeof src.tags === "string" ? src.tags.split(",").map((t) => t.trim()).filter(Boolean) : []);
  const srcOptions = src.options || [];
  const variants = src.variants?.edges ? src.variants.edges.map((e) => e.node) : (src.variants || []);

  const productInput = {
    title: src.title || "Untitled",
    descriptionHtml: src.descriptionHtml || src.body_html || "",
    vendor: src.vendor || "",
    productType: src.productType || src.product_type || "",
    tags,
    handle: src.handle || "",
    status: (src.status === "ACTIVE" || !!src.publishedAt || !!src.published_at) ? "ACTIVE" : "DRAFT",
  };
  const optionNames = srcOptions.map((o) => typeof o === "string" ? o : o.name);
  const normalizedVariants = variants.map((v) => {
    const gv = {};
    const sel = v.selectedOptions;
    if (sel?.length) gv.options = sel.map((s) => s.value).filter(Boolean);
    else {
      const opts = [v.option1, v.option2, v.option3].filter(Boolean);
      if (opts.length) gv.options = opts;
    }
    if (v.price) gv.price = v.price;
    if (v.compareAtPrice || v.compare_at_price) gv.compareAtPrice = v.compareAtPrice || v.compare_at_price;
    if (v.sku) gv.sku = v.sku;
    if (v.barcode) gv.barcode = v.barcode;
    const wt = v.inventoryItem?.measurement?.weight;
    const wVal = wt?.value ?? v.weight;
    if (wVal !== undefined && wVal !== null && wVal !== "") gv.weight = wVal;
    const wu = wt?.unit || v.weightUnit || v.weight_unit;
    if (wu) gv.weightUnit = wu;
    const ip = v.inventoryPolicy || v.inventory_policy;
    if (ip) gv.inventoryPolicy = ip;
    // requiresShipping now comes from InventoryItem, not the variant itself (see PRODUCT_QUERY).
    const rs = v.inventoryItem?.requiresShipping ?? v.requiresShipping;
    if (rs !== undefined) gv.requiresShipping = rs;
    else if (v.requires_shipping !== undefined) gv.requiresShipping = v.requires_shipping !== false;
    if (v.taxable !== undefined) gv.taxable = v.taxable;
    return gv;
  });

  // ProductInput no longer accepts "options"/"variants" directly (see
  // product-variants.server.js) — productCreate only sets up options and a
  // single placeholder variant; productVariantsBulkCreate does the rest.
  const { id, gid } = await createProductWithVariants({
    shopifyGraphql, shop: targetShop, token: targetToken, version,
    product: productInput, optionNames, variants: normalizedVariants,
  });

  // Images
  const images = src.images?.edges ? src.images.edges.map((e) => ({ src: e.node?.url, alt: e.node?.altText })).filter((i) => i.src) : (src.images || []);
  await uploadImages(targetShop, targetToken, gid, images, version);

  // Non-image media (video, 3D)
  if (srcId) {
    const media = await fetchSourceNonImageMedia(sourceShop, sourceToken, srcId, version);
    await uploadNonImageMedia(targetShop, targetToken, gid, media, version);
  }

  // Metafields — failures here must not fail the whole product transfer, but
  // are returned up to runMigrationWorker so they get persisted into the
  // job's errorLog instead of only reaching a console.warn.
  let metafieldErrors = [];
  if (srcId) {
    const mfResult = await copyMetafields(
      sourceShop, sourceToken, targetShop, targetToken,
      `gid://shopify/Product/${srcId}`, gid, version,
    );
    metafieldErrors = mfResult.errors;
  }

  return { id, gid, action: "created", metafieldErrors };
}

// ────────────────────────────────────────────────────────────────────────────
// Source product pagination
// ────────────────────────────────────────────────────────────────────────────

// Field-validity note (verified against the pinned API version, 2025-10, via
// shopify.dev's GraphQL reference): Product has no "giftCard" field — the
// correct name is "isGiftCard". ProductVariant.fulfillmentService was removed
// in 2022-10 with no query-side replacement. ProductVariant.requiresShipping
// moved onto InventoryItem. Any one invalid field makes the *entire* query
// fail to parse, so this wasn't a partial-data problem — every single page
// fetch failed and the whole migration job aborted immediately.
const PRODUCT_QUERY = `#graphql
  query SourceProducts($after: String) {
    products(first: ${BATCH_SIZE}, after: $after) {
      edges { cursor node {
        id title handle
        descriptionHtml vendor productType tags status publishedAt
        isGiftCard
        options { name }
        images(first: 250) { edges { node { url altText } } }
        variants(first: 100) { edges { node {
          title sku price compareAtPrice barcode taxable
          inventoryItem { measurement { weight { value unit } } requiresShipping }
          inventoryPolicy
          selectedOptions { name value }
        } } }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

async function fetchProductsPage(sourceShop, sourceToken, cursor, version) {
  const data = await shopifyGraphql(sourceShop, sourceToken, PRODUCT_QUERY, { after: cursor || null }, version);
  const edges = data?.products?.edges || [];
  return {
    products: edges.map((e) => e.node),
    nextCursor: data?.products?.pageInfo?.endCursor || null,
    hasNextPage: !!data?.products?.pageInfo?.hasNextPage,
  };
}

async function getProductCount(sourceShop, sourceToken, version) {
  try {
    const data = await shopifyGraphql(sourceShop, sourceToken, `{ productsCount { count } }`, {}, version);
    return data?.productsCount?.count || 0;
  } catch { return 0; }
}

// ────────────────────────────────────────────────────────────────────────────
// Main worker
// ────────────────────────────────────────────────────────────────────────────

export async function runMigrationWorker(jobId) {
  if (activeWorkers.has(jobId)) return; // already running
  activeWorkers.set(jobId, { startedAt: Date.now(), running: true });

  // Declared out here so the finally block can flush buffered log entries on
  // every exit path — normal completion, page-fetch failure, or an uncaught
  // throw — instead of losing whatever hadn't reached the flush threshold.
  let logBuffer = null;

  try {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) { activeWorkers.delete(jobId); return; }
    if (job.status === "COMPLETED" || job.status === "FAILED") { activeWorkers.delete(jobId); return; }

    const sourceToken = decrypt(job.sourceToken);
    const destToken = decrypt(job.destToken);
    const ctx = {
      targetShop: job.shop,
      targetToken: destToken,
      sourceShop: job.sourceShop,
      sourceToken,
      version: job.apiVersion,
      conflictMode: job.conflictMode,
    };

    await prisma.migrationJob.update({ where: { id: jobId }, data: { status: "RUNNING" } });
    console.log(`[migration-worker] job=${jobId} STARTED source=${job.sourceShop} dest=${job.shop} conflictMode=${job.conflictMode}`);

    // Declared before the backup step so backup warnings land in the same log
    // the rest of the job appends to.
    const errorLog = [];

    // ── Phase 2: pre-transfer backup of the DESTINATION, before any write ──
    // Only taken once per job: a resumed job (process restart) must not
    // re-snapshot, because by then the destination already contains records
    // this transfer created — that snapshot would be useless as an "undo".
    const backupPolicy = job.backupPolicy || "require";
    if (backupPolicy !== "skip" && !job.backupId) {
      const backupResult = await createBackup({
        prisma, shopifyGraphql,
        shop: job.shop, token: destToken, version: job.apiVersion, jobId,
      });

      await prisma.migrationJob.update({
        where: { id: jobId },
        data: { backupId: backupResult.backup?.id || null, backupStatus: backupResult.backup?.status || "FAILED" },
      });

      if (!backupResult.ok) {
        // "require" is the default precisely because the alternative is
        // running an irreversible transfer with no way back.
        if (backupPolicy === "require") {
          const message = `Pre-transfer backup failed, so the transfer was stopped before writing anything: ${backupResult.error}. Re-run with backupPolicy="skip" to proceed without a backup.`;
          console.error(`[migration-worker] job=${jobId} ABORTED — ${message}`);
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: { status: "FAILED", errorLog: JSON.stringify([{ type: "backup", error: message }]) },
          });
          return;
        }
        console.warn(`[migration-worker] job=${jobId} proceeding WITHOUT a backup (policy=${backupPolicy}): ${backupResult.error}`);
        errorLog.push({ type: "backup", error: `Proceeding without a backup: ${backupResult.error}` });
      } else if (backupResult.truncated) {
        // A partial backup is worse than no backup if the merchant assumes
        // it's complete — say so in the job's own error log.
        const message = `Destination store is larger than the snapshot cap, so the backup is PARTIAL — only the first ${backupResult.backup.productCount} products and ${backupResult.backup.collectionCount} collections can be restored.`;
        console.warn(`[migration-worker] job=${jobId} ${message}`);
        errorLog.push({ type: "backup", error: message });
      }
    }

    // Get total product count upfront for progress percentage
    if (!job.totalProducts) {
      const total = await getProductCount(job.sourceShop, sourceToken, job.apiVersion);
      if (total > 0) await prisma.migrationJob.update({ where: { id: jobId }, data: { totalProducts: total } });
    }

    let cursor = job.lastCursor || null;
    let processedDelta = 0;
    let failedDelta = 0;

    // Granular per-record log (Phase 2). Buffered so a 50k-product job doesn't
    // issue 50k INSERTs; best-effort so a logging failure can't abort the job.
    logBuffer = createLogBuffer({ prisma, jobId, shop: job.shop });

    // Fetch already-done product IDs from ProductMapping to skip on resume
    const doneSet = new Set();
    const doneMappings = await prisma.productMapping.findMany({
      where: { jobId, status: "DONE" },
      select: { sourceProductId: true },
    });
    for (const m of doneMappings) doneSet.add(m.sourceProductId);
    console.log(`[migration-worker] job=${jobId} resuming from cursor=${cursor} already-done=${doneSet.size}`);

    let hasMore = true;
    while (hasMore) {
      let page;
      try {
        page = await fetchProductsPage(job.sourceShop, sourceToken, cursor, job.apiVersion);
      } catch (err) {
        console.error(`[migration-worker] job=${jobId} failed to fetch product page:`, err.message);
        await prisma.migrationJob.update({
          where: { id: jobId },
          data: { status: "FAILED", errorLog: JSON.stringify([...errorLog, { error: `Fetch page failed: ${err.message}` }]) },
        });
        activeWorkers.delete(jobId);
        return;
      }

      const { products, nextCursor, hasNextPage } = page;
      hasMore = hasNextPage;

      // Process this page in small parallel batches
      for (let i = 0; i < products.length; i += CREATE_CONCURRENCY) {
        const slice = products.slice(i, i + CREATE_CONCURRENCY);
        await Promise.all(slice.map(async (src) => {
          const srcId = src.id?.split("/").pop();
          if (!srcId) return;

          // Skip if already transferred (idempotency on resume)
          if (doneSet.has(srcId)) return;

          try {
            const { id: destId, gid: destGid, skipped, action, reason, metafieldErrors } = await transferOneProduct(src, ctx);
            doneSet.add(srcId);
            // `action` is persisted for rollback safety: it's the only record
            // of whether THIS app created the destination product, or merely
            // skipped/overwrote one the merchant already had. Rollback refuses
            // to delete anything that isn't provably "created".
            const mappingAction = action || "created";
            await prisma.productMapping.upsert({
              where: { jobId_sourceProductId: { jobId, sourceProductId: srcId } },
              create: { jobId, sourceProductId: srcId, destProductId: destId, status: "DONE", action: mappingAction },
              update: { destProductId: destId, status: "DONE", error: null, action: mappingAction },
            });
            processedDelta++;
            if (skipped) console.log(`[migration-worker] job=${jobId} skipped (conflict): ${src.title}`);
            await logBuffer.add({
              entityType: ENTITY.PRODUCT,
              action: action || ACTION.CREATED,
              sourceId: srcId,
              destId,
              title: src.title,
              reason,
            });
            // Metafield failures don't fail the product transfer, but must
            // still be retrievable afterward — not just a console.warn.
            for (const mfErr of metafieldErrors || []) {
              errorLog.push({ sourceId: srcId, title: src.title || "(no title)", destId, type: "metafield", error: mfErr.error, payload: mfErr.payload });
              console.warn(`[migration-worker] job=${jobId} metafield copy failed for source=${srcId} dest=${destId}: ${mfErr.error}`);
              await logBuffer.add({
                entityType: ENTITY.METAFIELD,
                action: ACTION.FAILED,
                sourceId: srcId,
                destId,
                title: src.title,
                reason: mfErr.error,
                detail: mfErr.payload,
              });
            }
          } catch (err) {
            failedDelta++;
            const entry = { sourceId: srcId, title: src.title || "(no title)", error: err.message };
            errorLog.push(entry);
            console.warn(`[migration-worker] job=${jobId} product failed: ${srcId} — ${err.message}`);
            await prisma.productMapping.upsert({
              where: { jobId_sourceProductId: { jobId, sourceProductId: srcId } },
              create: { jobId, sourceProductId: srcId, status: "FAILED", error: err.message },
              update: { status: "FAILED", error: err.message },
            });
            await logBuffer.add({
              entityType: ENTITY.PRODUCT,
              action: ACTION.FAILED,
              sourceId: srcId,
              title: src.title,
              reason: err.message,
            });
          }
        }));

        // Checkpoint: flush progress to DB after every CHECKPOINT_EVERY products
        if ((processedDelta + failedDelta) % CHECKPOINT_EVERY === 0 || i + CREATE_CONCURRENCY >= products.length) {
          if (processedDelta > 0 || failedDelta > 0) {
            await prisma.migrationJob.update({
              where: { id: jobId },
              data: {
                processedProducts: { increment: processedDelta },
                failedProducts: { increment: failedDelta },
                lastCursor: cursor,
                errorLog: JSON.stringify(errorLog.slice(-200)),
              },
            });
            processedDelta = 0;
            failedDelta = 0;
          }
        }
      }

      // Advance cursor to end of this page
      if (nextCursor) {
        cursor = nextCursor;
        await prisma.migrationJob.update({ where: { id: jobId }, data: { lastCursor: cursor } });
      }

      // Small breathing room between pages to avoid hammering Shopify
      if (hasMore) await sleep(300);
    }

    // Flush any remaining delta
    if (processedDelta > 0 || failedDelta > 0) {
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: {
          processedProducts: { increment: processedDelta },
          failedProducts: { increment: failedDelta },
          errorLog: JSON.stringify(errorLog.slice(-200)),
        },
      });
    }

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", lastCursor: null, errorLog: JSON.stringify(errorLog.slice(-200)) },
    });
    console.log(`[migration-worker] job=${jobId} COMPLETED`);
  } catch (err) {
    console.error(`[migration-worker] job=${jobId} UNCAUGHT:`, err);
    try {
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: { status: "FAILED", errorLog: JSON.stringify([{ error: err.message }]) },
      });
    } catch { /* best-effort */ }
  } finally {
    // Persist whatever per-record log entries hadn't hit the flush threshold.
    // Best-effort: createLogBuffer.flush swallows its own errors, but guard
    // anyway so nothing here can mask the real job outcome.
    try { await logBuffer?.flush(); } catch { /* best-effort */ }
    activeWorkers.delete(jobId);
  }
}
