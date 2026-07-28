// ═══════════════════════════════════════════════════════════════════
// Phase 2 — Dry-run / preview mode with a real diff.
//
// The pre-existing dry run answered "how many records would we touch?" and
// tagged every one of them "dry-run". That can't tell a merchant the thing
// they actually need to know before committing: how many products get
// CREATED, how many get OVERWRITTEN, and how many are left alone.
//
// Efficiency matters here because this runs interactively, before the
// transfer. Classifying by querying the destination per source product would
// be one round trip per product — unusable at 50k. Instead the destination's
// handles are fetched once into an in-memory index, and classification is a
// pure function over that index.
// ═══════════════════════════════════════════════════════════════════

export const DIFF_ACTION = Object.freeze({
  CREATE: "create",
  UPDATE: "update",
  SKIP: "skip",
});

// Index enough per destination product to explain WHY something will change,
// without dragging descriptions/variants/media into a preview query.
const DEST_INDEX_PAGE_SIZE = 250;
const DEST_INDEX_QUERY = `#graphql
  query DestinationIndex($after: String) {
    products(first: ${DEST_INDEX_PAGE_SIZE}, after: $after) {
      edges { cursor node { id handle title vendor productType status } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

// Hard ceiling so a preview against a huge destination can't run unbounded.
export const MAX_DEST_INDEX_PRODUCTS = 50000;

// Builds Map<handle, destProduct> for the destination store.
// Returns { index, truncated } — truncated matters because a partial index
// would make existing products look like they need creating.
export async function fetchDestinationIndex({ shopifyGraphql, shop, token, version, max = MAX_DEST_INDEX_PRODUCTS }) {
  const index = new Map();
  let after = null;
  let hasNextPage = true;
  let truncated = false;

  while (hasNextPage) {
    const data = await shopifyGraphql(shop, token, DEST_INDEX_QUERY, { after }, version);
    const connection = data?.products;
    for (const edge of connection?.edges || []) {
      if (index.size >= max) { truncated = true; break; }
      const node = edge.node;
      if (node?.handle) index.set(node.handle, node);
    }
    if (truncated) break;
    hasNextPage = !!connection?.pageInfo?.hasNextPage;
    after = connection?.pageInfo?.endCursor || null;
    if (!after) break; // defensive: never loop forever on a malformed page
  }

  return { index, truncated };
}

// Fields compared to explain an update. Descriptions and variants are
// deliberately excluded: they're not in the index, and claiming "no changes"
// for fields we never looked at would be worse than saying nothing.
const COMPARED_FIELDS = [
  ["title", (p) => p.title],
  ["vendor", (p) => p.vendor],
  ["productType", (p) => p.productType ?? p.product_type],
  ["status", (p) => normalizeStatus(p)],
];

function normalizeStatus(p) {
  if (p.status) return String(p.status).toUpperCase();
  if (p.publishedAt || p.published_at) return "ACTIVE";
  return undefined;
}

export function diffFields(sourceProduct, destProduct) {
  const changes = [];
  for (const [name, get] of COMPARED_FIELDS) {
    const from = get(destProduct);
    const to = get(sourceProduct);
    // Only report a field the source actually specifies — an absent source
    // value isn't a change to empty, it's simply not part of this transfer.
    if (to === undefined || to === null || to === "") continue;
    if (String(from ?? "") !== String(to)) changes.push({ field: name, from: from ?? null, to });
  }
  return changes;
}

// Pure classification of one source product against the destination index.
export function classifyProduct(sourceProduct, destIndex, conflictMode = "skip") {
  const handle = sourceProduct?.handle || "";
  const title = sourceProduct?.title || "(untitled)";
  const sourceId = sourceProduct?.id ? String(sourceProduct.id).split("/").pop() : null;
  const base = { sourceId, handle, title };

  // conflictMode "create" ignores existing records entirely.
  if (conflictMode === "create") {
    const collides = handle && destIndex.has(handle);
    return {
      ...base,
      action: DIFF_ACTION.CREATE,
      destId: null,
      changes: [],
      // Genuinely useful preview info: Shopify won't reject this, it will
      // silently mint a suffixed handle, leaving two similar products.
      warning: collides
        ? "A product with this handle already exists — Shopify will append a suffix, creating a near-duplicate"
        : null,
    };
  }

  // Without a handle there's nothing to match on, so it can only be created.
  if (!handle) {
    return { ...base, action: DIFF_ACTION.CREATE, destId: null, changes: [], warning: "No handle on the source product — it cannot be matched against the destination" };
  }

  const existing = destIndex.get(handle);
  if (!existing) {
    return { ...base, action: DIFF_ACTION.CREATE, destId: null, changes: [], warning: null };
  }

  const destId = existing.id ? String(existing.id).split("/").pop() : null;

  if (conflictMode === "overwrite") {
    const changes = diffFields(sourceProduct, existing);
    return {
      ...base,
      action: DIFF_ACTION.UPDATE,
      destId,
      changes,
      // An overwrite with no detectable field change is still a write — say
      // so rather than implying it's a no-op.
      warning: changes.length === 0 ? "Will be overwritten, though no differences were detected in the compared fields" : null,
    };
  }

  // Default: skip.
  return { ...base, action: DIFF_ACTION.SKIP, destId, changes: [], warning: null, reason: "A product with this handle already exists on the destination" };
}

export function summarizeDiff(records = []) {
  const summary = { create: 0, update: 0, skip: 0, total: 0, warnings: 0 };
  for (const r of records) {
    summary.total++;
    if (summary[r.action] !== undefined) summary[r.action]++;
    if (r.warning) summary.warnings++;
  }
  return summary;
}

// Detects source products that share a handle with each other. Left to the
// caller to surface: whichever one loses the race silently overwrites or
// duplicates the other, and that's invisible without checking up front.
export function findDuplicateSourceHandles(sourceProducts = []) {
  const seen = new Map();
  const duplicates = [];
  for (const p of sourceProducts) {
    const handle = p?.handle;
    if (!handle) continue;
    const count = (seen.get(handle) || 0) + 1;
    seen.set(handle, count);
    if (count === 2) duplicates.push(handle);
  }
  return duplicates;
}

// Full preview: fetch the destination index once, classify every source
// product against it in memory. `records` is capped for transport; `summary`
// always reflects the complete set.
export async function computeTransferDiff({
  shopifyGraphql, destShop, destToken, version,
  sourceProducts, conflictMode = "skip", maxRecords = 500,
}) {
  const { index, truncated } = await fetchDestinationIndex({
    shopifyGraphql, shop: destShop, token: destToken, version,
  });

  const records = (sourceProducts || []).map((p) => classifyProduct(p, index, conflictMode));
  const summary = summarizeDiff(records);
  const duplicateHandles = findDuplicateSourceHandles(sourceProducts);

  return {
    summary,
    records: records.slice(0, maxRecords),
    recordsTruncated: records.length > maxRecords,
    destIndexTruncated: truncated,
    destIndexSize: index.size,
    duplicateSourceHandles: duplicateHandles,
    conflictMode,
  };
}
