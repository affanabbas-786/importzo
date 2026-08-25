// Background product-migration worker.
// Runs as a fire-and-forget Promise inside the Node.js process — fully decoupled
// from the HTTP request that created the MigrationJob. On process restart PM2
// brings the app back; the status endpoint auto-resumes any RUNNING job.

import prisma from "../db.server.js";
import { decrypt } from "../utils/encryption.server.js";
import { shopifyGraphql, handleSearchQuery } from "./shopify-api.server.js";
import { createProductWithVariants } from "./product-variants.server.js";
import { createLogBuffer, ACTION, ENTITY } from "./transfer-log.server.js";
import { createBackup } from "./backup.server.js";
import { actorFromRecord, describeActor } from "./audit.server.js";
import { marketQueryFilter } from "./markets.server.js";
import { assertQuotaAvailable, recordUsageAndCheck } from "./usage.server.js";
import { createAltTextGenerator } from "./alt-text.server.js";
import { createTokenProvider, isAuthError } from "./job-tokens.server.js";

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

// Conflict detection: does the destination already have a product with this
// handle?
//
// Returns { ok: true, product } — where `product` is null for a definitive
// "no such handle" — or { ok: false, error } when the question could not be
// answered at all.
//
// That distinction is the whole point, and getting it wrong was a silent
// catalog-duplication bug. This used to `catch { return null }`, collapsing
// "Shopify says there is no such product" and "the lookup failed" into the
// same answer. The caller treats null as permission to create, so ANY
// transient failure here — a 429 that outlived the five retries in
// shopify-api.server.js, a 500, a dropped connection, an expired token —
// silently downgraded conflictMode "skip" and "overwrite" into "create".
//
// The merchant who picked "skip" picked it precisely so a re-run would not
// duplicate their catalog, and the resumed/retried run is exactly when a
// transient error is most likely. Failing the product instead is strictly
// better: a FAILED row is visible in the job log, is retryable, and changes
// nothing on the destination, whereas a duplicate is silent and has to be
// cleaned out of a live store by hand.
async function findProductByHandle(targetShop, targetToken, handle, version) {
  if (!handle) return { ok: true, product: null };
  try {
    const data = await shopifyGraphql(targetShop, targetToken, `#graphql
      query FindProduct($query: String!) {
        products(first: 1, query: $query) { edges { node { id handle } } }
      }`, { query: handleSearchQuery(handle) }, version);
    return { ok: true, product: data?.products?.edges?.[0]?.node || null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Creates (or skips/overwrites based on conflictMode) a single product on the destination.
// Returns { id, gid, action, metafieldErrors } of the destination product.
//
// `action` is "created" | "updated" | "skipped" and is load-bearing beyond
// logging: rollback uses it to know which destination products this app
// actually created, so an "skipped" product (one that already existed on the
// destination and is the merchant's own data) is never deleted by an undo.
// Phase 4.2: tags a product with its source market, e.g. "market:eu".
// Applied to both the create and overwrite paths so a market-scoped
// transfer is identifiable on the destination either way. Idempotent
// against re-runs — dedupes rather than appending the tag twice.
function withMarketTag(tags, marketTag) {
  if (!marketTag) return tags;
  const tag = `market:${marketTag}`;
  return tags.includes(tag) ? tags : [...tags, tag];
}

async function transferOneProduct(src, ctx) {
  const { targetShop, targetToken, sourceShop, sourceToken, version, conflictMode, marketTag, altGen } = ctx;
  const srcId = src.id?.split("/").pop();

  if (src.isGiftCard || src.giftCard || src.gift_card) throw new Error("Gift card products cannot be transferred");

  // Conflict detection
  if (src.handle && conflictMode !== "create") {
    const lookup = await findProductByHandle(targetShop, targetToken, src.handle, version);
    // Could not determine whether the destination already has this handle.
    // Refuse to guess: creating would duplicate the merchant's product, which
    // is the one outcome conflictMode=skip/overwrite exists to prevent. Throw
    // so this product is recorded FAILED and can be retried — and so an auth
    // failure here reaches runMigrationWorker's isAuthError path, which
    // refreshes the token and retries the product properly.
    if (!lookup.ok) {
      throw new Error(
        `Could not check whether "${src.handle}" already exists on the destination ` +
        `(${lookup.error}). Skipped rather than risk creating a duplicate — re-run the transfer to retry.`,
      );
    }
    const existing = lookup.product;
    if (existing) {
      if (conflictMode === "skip") return { id: existing.id.split("/").pop(), gid: existing.id, skipped: true, action: "skipped", reason: "A product with this handle already exists on the destination" };
      if (conflictMode === "overwrite") {
        const tags = withMarketTag(Array.isArray(src.tags) ? src.tags : (typeof src.tags === "string" ? src.tags.split(",").map((t) => t.trim()).filter(Boolean) : []), marketTag);
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

  const tags = withMarketTag(Array.isArray(src.tags) ? src.tags : (typeof src.tags === "string" ? src.tags.split(",").map((t) => t.trim()).filter(Boolean) : []), marketTag);
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

  // Images. Phase 6: the source store's own alt text (when present) is
  // always preserved as-is — AI generation only fills in images that have
  // none, same rule as app.transfer.jsx's sync path.
  let images = src.images?.edges ? src.images.edges.map((e) => ({ src: e.node?.url, alt: e.node?.altText })).filter((i) => i.src) : (src.images || []);
  if (altGen?.enabled && images.some((i) => !i.alt)) {
    const generatedAlt = await altGen.generate({ title: src.title, description: src.descriptionHtml });
    if (generatedAlt) images = images.map((i) => (i.alt ? i : { ...i, alt: generatedAlt }));
  }
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

// Field-validity note (verified against the pinned API version, 2026-04, via
// shopify.dev's GraphQL reference): Product has no "giftCard" field — the
// correct name is "isGiftCard". ProductVariant.fulfillmentService was removed
// in 2022-10 with no query-side replacement. ProductVariant.requiresShipping
// moved onto InventoryItem. Any one invalid field makes the *entire* query
// fail to parse, so this wasn't a partial-data problem — every single page
// fetch failed and the whole migration job aborted immediately.
const PRODUCT_QUERY = `#graphql
  query SourceProducts($after: String, $query: String) {
    products(first: ${BATCH_SIZE}, after: $after, query: $query) {
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

async function fetchProductsPage(sourceShop, sourceToken, cursor, version, marketQuery) {
  const data = await shopifyGraphql(sourceShop, sourceToken, PRODUCT_QUERY, { after: cursor || null, query: marketQuery || null }, version);
  const edges = data?.products?.edges || [];
  return {
    products: edges.map((e) => e.node),
    nextCursor: data?.products?.pageInfo?.endCursor || null,
    hasNextPage: !!data?.products?.pageInfo?.hasNextPage,
  };
}

async function getProductCount(sourceShop, sourceToken, version, marketQuery) {
  try {
    const data = await shopifyGraphql(sourceShop, sourceToken, `#graphql
      query ProductsCount($query: String) { productsCount(query: $query) { count } }`,
      { query: marketQuery || null }, version);
    return data?.productsCount?.count || 0;
  } catch { return 0; }
}

// ────────────────────────────────────────────────────────────────────────────
// Main worker
// ────────────────────────────────────────────────────────────────────────────

export async function runMigrationWorker(jobId, { createTokens = createTokenProvider } = {}) {
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

    // The tokens stored on the job are a SNAPSHOT taken when it was created,
    // and offline access tokens live only 60 minutes — see
    // job-tokens.server.js. Both are therefore treated as fallbacks behind a
    // provider that re-resolves (and thereby renews) the real token from the
    // session store as the job runs. Anything longer than an hour, and every
    // resumed or scheduled job, depends on this.
    const sourceTokens = createTokens({ shop: job.sourceShop, fallbackToken: decrypt(job.sourceToken) });
    const destTokens = createTokens({ shop: job.shop, fallbackToken: decrypt(job.destToken) });
    const sourceToken = await sourceTokens.get();
    const destToken = await destTokens.get();

    // Phase 4.2: market-scoped transfer, resolved and snapshotted onto the
    // job at creation time (api.migration-job.jsx) rather than re-fetched
    // here — a resumed job must filter identically to how it started.
    let marketPublicationIds = null;
    try {
      marketPublicationIds = job.sourceMarketPublicationIds ? JSON.parse(job.sourceMarketPublicationIds) : null;
    } catch { marketPublicationIds = null; }
    const marketQuery = marketQueryFilter({ publicationIds: marketPublicationIds });

    // Phase 6 — opt-in AI alt-text, resolved once per job run (not per
    // product) — see alt-text.server.js. `job.altTextAutoGenerate` was
    // snapshotted at job creation (api.migration-job.jsx), same reasoning
    // as conflictMode below.
    const altGen = job.altTextAutoGenerate
      ? await createAltTextGenerator({ prisma, shop: job.shop })
      : { enabled: false };

    const ctx = {
      targetShop: job.shop,
      targetToken: destToken,
      sourceShop: job.sourceShop,
      sourceToken,
      version: job.apiVersion,
      conflictMode: job.conflictMode,
      marketTag: job.sourceMarketHandle || null,
      altGen,
    };

    await prisma.migrationJob.update({ where: { id: jobId }, data: { status: "RUNNING" } });
    console.log(`[migration-worker] job=${jobId} STARTED source=${job.sourceShop} dest=${job.shop} conflictMode=${job.conflictMode} triggeredBy=${describeActor(actorFromRecord(job))}`);

    // Declared before the backup step so backup warnings land in the same log
    // the rest of the job appends to.
    const errorLog = [];

    // ── Phase 5: refuse to start at all if this shop (the destination —
    // the one whose Importzo plan and usage this counts against) has
    // already used its full monthly allowance. Checked before the backup
    // step so a capped-out shop doesn't pay for an expensive snapshot on a
    // job that can create zero records.
    const quotaGate = await assertQuotaAvailable({ prisma, shop: job.shop });
    if (!quotaGate.ok) {
      console.warn(`[migration-worker] job=${jobId} REFUSED — ${quotaGate.message}`);
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: { status: "FAILED", errorLog: JSON.stringify([{ type: "quota", error: quotaGate.message }]) },
      });
      activeWorkers.delete(jobId);
      return;
    }

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
      const total = await getProductCount(job.sourceShop, sourceToken, job.apiVersion, marketQuery);
      if (total > 0) await prisma.migrationJob.update({ where: { id: jobId }, data: { totalProducts: total } });
    }

    let cursor = job.lastCursor || null;
    let processedDelta = 0;
    let failedDelta = 0;
    // Phase 5: flips true the moment this shop's plan limit is hit mid-job.
    // Products already in flight (CREATE_CONCURRENCY batches) still finish,
    // but every product after that is skipped rather than created — "block
    // mid-transfer" rather than silently writing past a capped plan.
    let quotaExceeded = false;

    // Granular per-record log (Phase 2). Buffered so a 50k-product job doesn't
    // issue 50k INSERTs; best-effort so a logging failure can't abort the job.
    //
    // Phase 3.7: this worker has no request, so the actor comes from what was
    // recorded on the job when a human (or a schedule) triggered it. Every
    // entry written below is attributed to them.
    const actor = actorFromRecord(job);
    logBuffer = createLogBuffer({ prisma, jobId, shop: job.shop, actor });

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
      // A page fetch failing is fatal to the whole job, so an expired source
      // token gets one retry with a freshly-resolved one before giving up.
      let page;
      try {
        page = await fetchProductsPage(job.sourceShop, await sourceTokens.get(), cursor, job.apiVersion, marketQuery);
      } catch (err) {
        let fatal = err;
        if (isAuthError(err)) {
          sourceTokens.invalidate();
          try {
            page = await fetchProductsPage(job.sourceShop, await sourceTokens.get(), cursor, job.apiVersion, marketQuery);
            fatal = null;
          } catch (retryErr) {
            fatal = retryErr;
          }
        }
        if (fatal) {
          console.error(`[migration-worker] job=${jobId} failed to fetch product page:`, fatal.message);
          await prisma.migrationJob.update({
            where: { id: jobId },
            data: { status: "FAILED", errorLog: JSON.stringify([...errorLog, { error: `Fetch page failed: ${fatal.message}` }]) },
          });
          activeWorkers.delete(jobId);
          return;
        }
      }

      const { products, nextCursor, hasNextPage } = page;
      hasMore = hasNextPage;

      // Process this page in small parallel batches
      for (let i = 0; i < products.length; i += CREATE_CONCURRENCY) {
        const slice = products.slice(i, i + CREATE_CONCURRENCY);

        // Re-point ctx at the current tokens before every batch. Both calls
        // are cache hits for ~20 minutes at a time, so this is nearly free;
        // what it buys is that a job running longer than a token's 60-minute
        // life keeps working instead of 401-ing every remaining product.
        ctx.targetToken = await destTokens.get();
        ctx.sourceToken = await sourceTokens.get();

        await Promise.all(slice.map(async (src) => {
          const srcId = src.id?.split("/").pop();
          if (!srcId) {
            // A source row the destination can never be reconciled against.
            // This used to be a bare `return`: the product vanished from the
            // transfer counted as neither processed nor failed, with no log
            // entry and no console line, so a merchant comparing catalogs
            // afterwards would find something missing and have nothing at all
            // to explain it. Malformed source data must fail LOUDLY.
            failedDelta++;
            const reason = "Source product has no id — it cannot be transferred or tracked. This usually means malformed data from the source store.";
            errorLog.push({ sourceId: null, title: src.title || "(no title)", error: reason });
            console.warn(`[migration-worker] job=${jobId} product with no id skipped: ${src.title || "(no title)"}`);
            await logBuffer.add({
              entityType: ENTITY.PRODUCT,
              action: ACTION.FAILED,
              title: src.title,
              reason,
            });
            return;
          }

          // Skip if already transferred (idempotency on resume)
          if (doneSet.has(srcId)) return;

          // Phase 5: once the shop's plan limit is hit mid-job, stop creating
          // new records. Logged like any other skip so the merchant sees
          // exactly which products this transfer did NOT reach.
          if (quotaExceeded) {
            await logBuffer.add({
              entityType: ENTITY.PRODUCT,
              action: ACTION.SKIPPED,
              sourceId: srcId,
              title: src.title,
              reason: "Skipped — plan limit reached (upgrade to continue)",
            });
            return;
          }

          try {
            let result;
            try {
              result = await transferOneProduct(src, ctx);
            } catch (err) {
              // An expired token must not be recorded as "this product could
              // not be transferred" — that is a job-level problem wearing a
              // per-product disguise, and it is how a long migration used to
              // mark thousands of perfectly good products FAILED. Re-resolve
              // and give the product one honest second attempt.
              if (!isAuthError(err)) throw err;
              destTokens.invalidate();
              sourceTokens.invalidate();
              ctx.targetToken = await destTokens.get();
              ctx.sourceToken = await sourceTokens.get();
              console.warn(`[migration-worker] job=${jobId} auth error on ${srcId} — retrying with a refreshed token`);
              result = await transferOneProduct(src, ctx);
            }
            const { id: destId, skipped, action, reason, metafieldErrors } = result;
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
            // Phase 5: only a real create/update consumes quota — a
            // conflictMode=skip product (the destination already had it,
            // untouched) is not a new record.
            if (mappingAction === "created" || mappingAction === "updated") {
              const { limitReached } = await recordUsageAndCheck({ prisma, shop: job.shop, count: 1 });
              if (limitReached && !quotaExceeded) {
                quotaExceeded = true;
                const message = "Reached this store's monthly plan limit partway through the transfer — remaining products were skipped. Upgrade your plan to continue.";
                console.warn(`[migration-worker] job=${jobId} ${message}`);
                errorLog.push({ type: "quota", error: message });
              }
            }
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

      // Phase 5: quota was hit somewhere in this page — every remaining
      // product in the page was already logged as skipped above. No point
      // fetching further pages from Shopify just to skip those too.
      if (quotaExceeded) {
        hasMore = false;
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
