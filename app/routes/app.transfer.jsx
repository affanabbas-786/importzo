import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { decrypt } from "../utils/encryption.server";
import {
  getSavedSourceStore,
  upsertSourceStore,
  touchSourceStore,
  deleteSourceStore,
} from "../lib/safe-db";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { ErrorBanner } from "../components/ui";
import { loadPrefs } from "../lib/prefs";
import { friendlyError, summarizeFailures } from "../lib/friendly-errors";
import { notifyJobComplete } from "../lib/notify";
import { saveThemeZip, deleteThemeZipLater } from "../lib/theme-zip.server";
import { shopifyFetch as sharedShopifyFetch, shopifyGraphql as sharedShopifyGraphql } from "../lib/shopify-api.server";
import { createProductWithVariants } from "../lib/product-variants.server";
import { listMarkets } from "../lib/markets.server";
import { assertQuotaAvailable, recordUsageAndCheck, assertAiQuotaAvailable, recordAiUsage } from "../lib/usage.server";
import { createAltTextGenerator } from "../lib/alt-text.server";
import { getAiIntegrationForUse } from "../lib/ai-settings.server";
import { detectSimilarProducts } from "../lib/ai-provider.server";
import { LeafIcon } from "../components/decor";

// ═══════════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════════
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // Safe wrapper — never throws, returns null if the table/model is
  // missing so the page still renders with a clean "Connect" state.
  const saved = await getSavedSourceStore(session.shop);
  return {
    currentShop: session.shop, // the store this app is installed on = DESTINATION
    savedConnection: saved
      ? { sourceUrl: saved.sourceUrl, sourceName: saved.sourceName, sourceEmail: saved.sourceEmail, sourcePlan: saved.sourcePlan, lastUsed: saved.lastUsed }
      : null,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetShop = session.shop;
  const targetToken = session.accessToken;
  const version = apiVersion || "2025-10";
  const THEME_API_VERSION = version;
  const rid = formData.get("rid") || "";

  // Phase 5 — billing: refuse to start any write-producing intent at all if
  // this shop has already used its full monthly plan allowance. Checked once
  // here rather than per-intent since it applies identically to all four.
  // `quotaExceeded` is shared (closed over) by every helper/intent below —
  // only one intent ever runs per request, so a single flag is enough to let
  // a batch loop stop starting new work once the cap is hit mid-transfer.
  const WRITE_INTENTS = new Set(["transfer", "transfer-products", "transfer-theme", "transfer-content"]);
  let quotaExceeded = false;
  if (WRITE_INTENTS.has(intent)) {
    const quotaGate = await assertQuotaAvailable({ prisma, shop: targetShop });
    if (!quotaGate.ok) {
      return { intent, rid, ok: false, error: quotaGate.message };
    }
  }

  // Phase 6 — opt-in AI alt-text for images copied without any (the source
  // store's own alt text, when present, is always preferred and this is
  // never called for it — see createProductOnTarget below). Resolved once
  // per request, not per product — see alt-text.server.js.
  const altTextAutoGenerate = formData.get("altTextAutoGenerate") === "true";
  const altGen = altTextAutoGenerate && WRITE_INTENTS.has(intent)
    ? await createAltTextGenerator({ prisma, shop: targetShop })
    : { enabled: false };

  // Helper: get source credentials — checks active TransferSession first, then falls
  // back to form data or saved SourceStore (legacy / direct-token flow).
  async function getSourceCreds() {
    // ── Session-based path (new secure flow) ──────────────────────────────────
    const sessionId = (formData.get("sessionId") || "").trim();
    if (sessionId) {
      try {
        const ts = await prisma.transferSession.findUnique({ where: { id: sessionId } });
        if (ts && ts.status !== "done") {
          return { url: ts.sourceShop, token: decrypt(ts.sourceToken) };
        }
      } catch (err) {
        // Model may not exist on older deployments — fall through gracefully
        console.warn("[importzo] getSourceCreds session lookup:", err?.message);
      }
    }
    // ── Legacy / direct-token path ────────────────────────────────────────────
    let url = (formData.get("sourceUrl") || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    let token = (formData.get("sourceToken") || "").trim();
    if (!url || !token) {
      const saved = await getSavedSourceStore(session.shop);
      if (saved) { url = saved.sourceUrl; token = saved.token; }
    }
    if (url && !url.includes(".")) url = url + ".myshopify.com";
    return { url, token };
  }

  // 429 backoff + GraphQL cost-throttle awareness now live in the shared
  // shopify-api.server.js helper (also used by migration-worker.server.js and
  // app.export.jsx). These local wrappers preserve the call signatures every
  // intent handler below already uses (no version param — closed over here).
  const shopifyFetch = sharedShopifyFetch;
  async function shopifyGraphql(shop, token, query, variables = {}) {
    return sharedShopifyGraphql(shop, token, query, variables, version);
  }

  function mediaContentTypeFromUrl(url = "") {
    const clean = String(url).split("?")[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(clean)) return "IMAGE";
    if (/\.(mp4|mov|m4v|webm)$/.test(clean)) return "VIDEO";
    if (/\.(glb|usdz)$/.test(clean)) return "MODEL_3D";
    return "FILE";
  }

  function filenameFromUrlOrRef(value = "") {
    const raw = String(value || "").trim();
    if (!raw) return "";
    let name = raw;
    if (raw.startsWith("shopify://shop_images/")) {
      name = raw.replace(/^shopify:\/\/shop_images\//, "");
    } else {
      try {
        const u = new URL(raw);
        const parts = u.pathname.split("/").filter(Boolean);
        name = parts[parts.length - 1] || "";
      } catch {
        const parts = raw.split("/").filter(Boolean);
        name = parts[parts.length - 1] || raw;
      }
    }
    try { name = decodeURIComponent(name); } catch { /* keep original */ }
    return name.split("?")[0].split("#")[0];
  }

  function candidateFileUrls(sourceShop, filename) {
    const encoded = filename.split("/").map(encodeURIComponent).join("/");
    return [
      `https://${sourceShop}/cdn/shop/files/${encoded}`,
      `https://${sourceShop}/cdn/shop/files/${encoded}?v=1`,
    ];
  }

  function extractThemeFileReferences(files) {
    const refs = new Map();
    const add = (raw) => {
      const name = filenameFromUrlOrRef(raw);
      if (!name || refs.has(name)) return;
      refs.set(name, { filename: name, original: raw });
    };

    for (const file of files) {
      const name = String(file.name || "");
      if (!/(\.json|\.liquid|\.css|\.js|\.scss|\.txt)$/i.test(name)) continue;
      const text = Buffer.isBuffer(file.data) ? file.data.toString("utf8") : String(file.data || "");
      for (const m of text.matchAll(/shopify:\/\/shop_images\/([^"'\\\s,)]+[^"'\\\s,)]*)/g)) add(`shopify://shop_images/${m[1]}`);
      for (const m of text.matchAll(/https?:\/\/[^"'\\\s)]+\/cdn\/shop\/files\/([^"'\\\s)]+)/g)) add(m[0]);
      for (const m of text.matchAll(/https?:\/\/cdn\.shopify\.com\/s\/files\/[^"'\\\s)]*\/files\/([^"'\\\s)]+)/g)) add(m[0]);
    }
    return [...refs.values()];
  }

  async function createFilesOnTargetFromThemeRefs(sourceShop, targetShop, targetToken, refs) {
    if (!refs.length) return { total: 0, uploaded: 0, warnings: [] };
    const warnings = [];
    let uploaded = 0;

    const mutation = `#graphql
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id fileStatus alt createdAt ... on GenericFile { url } }
          userErrors { field message code }
        }
      }`;

    for (let i = 0; i < refs.length; i += 25) {
      const batch = refs.slice(i, i + 25).map((ref) => {
        const originalSource = ref.original.startsWith("http") ? ref.original : candidateFileUrls(sourceShop, ref.filename)[0];
        return {
          contentType: mediaContentTypeFromUrl(ref.filename),
          originalSource,
          filename: ref.filename,
          alt: ref.filename.replace(/[-_]+/g, " ").replace(/\.[^.]+$/, "").slice(0, 500),
        };
      });
      try {
        const data = await shopifyGraphql(targetShop, targetToken, mutation, { files: batch });
        const errors = data?.fileCreate?.userErrors || [];
        const files = data?.fileCreate?.files || [];
        uploaded += files.length;
        if (errors.length) warnings.push(...errors.map((e) => `${e.message}${e.field ? ` (${e.field.join(".")})` : ""}`));
      } catch (err) {
        warnings.push(`Theme file media batch failed: ${err.message}`);
      }
      if (i + 25 < refs.length) await new Promise((r) => setTimeout(r, 1000));
    }
    return { total: refs.length, uploaded, warnings };
  }

  async function uploadProductImagesToTarget(productGid, images = []) {
    const warnings = [];
    let uploaded = 0;
    const validImages = images.filter((img) => img.src && /^https?:\/\//i.test(img.src)).slice(0, 250);
    if (!validImages.length) return { uploaded: 0, total: 0, warnings };
    const mutation = `#graphql
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id mediaContentType status }
          mediaUserErrors { field message code }
        }
      }`;
    for (let i = 0; i < validImages.length; i += 20) {
      const batch = validImages.slice(i, i + 20).map((img) => ({
        originalSource: img.src,
        mediaContentType: "IMAGE",
        alt: img.alt || undefined,
      }));
      try {
        const data = await shopifyGraphql(targetShop, targetToken, mutation, { productId: productGid, media: batch });
        const created = data?.productCreateMedia?.media || [];
        const errors = data?.productCreateMedia?.mediaUserErrors || [];
        uploaded += created.length;
        if (errors.length) warnings.push(...errors.map((e) => e.message));
      } catch (err) {
        warnings.push(`Image batch failed: ${err.message}`);
      }
      if (i + 20 < validImages.length) await new Promise((r) => setTimeout(r, 500));
    }
    return { uploaded, total: validImages.length, warnings };
  }

  async function fetchSourceProductNonImageMedia(sourceShop, sourceToken, productId) {
    const query = `#graphql
      query ProductMedia($id: ID!) {
        product(id: $id) {
          media(first: 100) {
            nodes {
              mediaContentType
              alt
              ... on Video { sources { url mimeType format } }
              ... on ExternalVideo { originUrl }
              ... on Model3d { sources { url mimeType format } }
            }
          }
        }
      }`;
    try {
      const data = await shopifyGraphql(sourceShop, sourceToken, query, { id: `gid://shopify/Product/${productId}` });
      const nodes = data?.product?.media?.nodes || [];
      return nodes
        .filter((m) => m.mediaContentType && m.mediaContentType !== "IMAGE")
        .map((m) => {
          if (m.mediaContentType === "EXTERNAL_VIDEO" && m.originUrl) return { mediaContentType: "EXTERNAL_VIDEO", originalSource: m.originUrl, alt: m.alt || "" };
          const source = (m.sources || []).find((src) => src.url && /^https?:\/\//i.test(src.url));
          if (!source) return null;
          return { mediaContentType: m.mediaContentType, originalSource: source.url, alt: m.alt || "" };
        })
        .filter(Boolean);
    } catch (err) {
      console.warn(`[importzo] source product media read failed for ${productId}:`, err?.message || err);
      return [];
    }
  }

  async function uploadProductMediaToTarget(productGid, media = []) {
    if (!media.length) return { uploaded: 0, total: 0, warnings: [] };
    const mutation = `#graphql
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id mediaContentType status }
          mediaUserErrors { field message code }
        }
      }`;
    const warnings = [];
    let uploaded = 0;
    for (let i = 0; i < media.length; i += 20) {
      const batch = media.slice(i, i + 20);
      try {
        const data = await shopifyGraphql(targetShop, targetToken, mutation, { productId: productGid, media: batch });
        const created = data?.productCreateMedia?.media || [];
        const errors = data?.productCreateMedia?.mediaUserErrors || [];
        uploaded += created.length;
        if (errors.length) warnings.push(...errors.map((e) => `${e.message}${e.field ? ` (${e.field.join(".")})` : ""}`));
      } catch (err) {
        warnings.push(`Product video/3D media failed: ${err.message}`);
      }
      if (i + 20 < media.length) await new Promise((r) => setTimeout(r, 1000));
    }
    return { uploaded, total: media.length, warnings };
  }

  // Helper: look up existing product by handle on target store.
  //
  // Returns { ok: true, product } (product === null means "definitively no
  // such handle") or { ok: false, error } when the lookup itself failed.
  //
  // The two must stay distinguishable. This previously returned null for
  // both, and the caller reads null as "safe to create" — so a transient
  // failure (a 429 past shopify-api.server.js's retries, a 5xx, an expired
  // token) silently turned conflictMode "skip"/"overwrite" into "create" and
  // duplicated the merchant's product. Same bug, same reasoning, as the copy
  // in migration-worker.server.js — this is the synchronous transfer path.
  async function findProductByHandle(handle) {
    if (!handle) return { ok: true, product: null };
    try {
      const data = await shopifyGraphql(targetShop, targetToken, `#graphql
        query FindProduct($query: String!) {
          products(first: 1, query: $query) {
            edges { node { id handle title } }
          }
        }`, { query: `handle:${handle}` });
      return { ok: true, product: data?.products?.edges?.[0]?.node || null };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // Phase 6 — fuzzy duplicate detection (dry-run preview only, never on a
  // real write). Single page, capped at the same MAX_TITLES_PER_LIST the AI
  // prompt itself caps to — see ai-provider.server.js — so there's no point
  // fetching more than would ever be sent.
  async function fetchExistingProductTitles(limit = 200) {
    try {
      const data = await shopifyGraphql(targetShop, targetToken, `#graphql
        query ExistingProductTitles($first: Int!) {
          products(first: $first) { edges { node { title } } }
        }`, { first: limit });
      return (data?.products?.edges || []).map((e) => e.node?.title).filter(Boolean);
    } catch (err) {
      console.warn(`[importzo] fetchExistingProductTitles failed: ${err.message}`);
      return [];
    }
  }

  // Helper: update an existing product on target store
  async function updateProductOnTarget(existingGid, src) {
    const tags = Array.isArray(src.tags) ? src.tags : (typeof src.tags === "string" ? src.tags.split(",").map((t) => t.trim()).filter(Boolean) : []);
    const gqlInput = {
      id: existingGid,
      title: src.title || "Untitled",
      descriptionHtml: src.descriptionHtml || src.body_html || "",
      vendor: src.vendor || "",
      productType: src.productType || src.product_type || "",
      tags,
    };
    const data = await shopifyGraphql(targetShop, targetToken, `#graphql
      mutation ProductUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }`, { input: gqlInput });
    const userErrors = data?.productUpdate?.userErrors || [];
    if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
    const updated = data?.productUpdate?.product;
    if (!updated) throw new Error("Product update failed: no product returned");
    return { id: updated.id.split("/").pop(), gid: updated.id, warnings: ["Overwrote existing product"] };
  }

  // Helper: create a single product on target store (with conflict mode)
  const conflictMode = formData.get("conflictMode") || "create";

  async function createProductOnTarget(src, sourceShopForMedia = null, sourceTokenForMedia = null) {
    const srcId = src.id?.split("/").pop();
    if (src.giftCard || src.gift_card) throw new Error("Gift card products cannot be transferred");

    // Conflict detection: look up by handle
    if (src.handle && conflictMode !== "create") {
      const lookup = await findProductByHandle(src.handle);
      // Unknown whether the handle already exists — fail this product rather
      // than create a duplicate of the merchant's own data. A failed row is
      // visible and retryable; a duplicate has to be cleaned up by hand.
      if (!lookup.ok) {
        throw new Error(
          `Could not check whether "${src.handle}" already exists on the destination ` +
          `(${lookup.error}). Skipped rather than risk creating a duplicate — re-run the transfer to retry.`,
        );
      }
      const existing = lookup.product;
      if (existing) {
        if (conflictMode === "skip") {
          return { id: existing.id.split("/").pop(), gid: existing.id, warnings: ["Skipped — product already exists"], skipped: true };
        }
        if (conflictMode === "overwrite") {
          const updated = await updateProductOnTarget(existing.id, src);
          // Phase 5: an overwrite is a real record, same as a create.
          const { limitReached } = await recordUsageAndCheck({ prisma, shop: targetShop, count: 1 });
          if (limitReached) quotaExceeded = true;
          return updated;
        }
      }
    }

    const tags = Array.isArray(src.tags) ? src.tags : (typeof src.tags === "string" ? src.tags.split(",").map((t) => t.trim()).filter(Boolean) : []);

    const productInput = {
      title: src.title || "Untitled",
      descriptionHtml: src.descriptionHtml || src.body_html || "",
      vendor: src.vendor || "",
      productType: src.productType || src.product_type || "",
      tags,
      handle: src.handle || "",
      status: (src.status === "ACTIVE" || !!src.publishedAt || !!src.published_at) ? "ACTIVE" : "DRAFT",
    };

    const srcOptions = src.options || [];
    const optionNames = srcOptions.map((o) => typeof o === "string" ? o : o.name);

    // Variants — handle both GraphQL edges format and REST array format
    const variants = src.variants?.edges
      ? src.variants.edges.map((e) => e.node)
      : (src.variants || []);
    const normalizedVariants = variants.map((v) => {
      const gv = {};
      // GraphQL selectedOptions or REST option1/2/3
      const sel = v.selectedOptions;
      if (sel?.length) {
        gv.options = sel.map((s) => s.value).filter(Boolean);
      } else {
        const opts = [v.option1, v.option2, v.option3].filter(Boolean);
        if (opts.length) gv.options = opts;
      }
      if (v.price) gv.price = v.price;
      if (v.compareAtPrice || v.compare_at_price) gv.compareAtPrice = v.compareAtPrice || v.compare_at_price;
      if (v.sku) gv.sku = v.sku;
      if (v.barcode) gv.barcode = v.barcode;
      const gqlWeight = v.inventoryItem?.measurement?.weight;
      const wVal = gqlWeight?.value ?? v.weight;
      if (wVal !== undefined && wVal !== null && wVal !== "") gv.weight = wVal;
      const wu = gqlWeight?.unit || v.weightUnit || v.weight_unit;
      if (wu) gv.weightUnit = wu;
      const ip = v.inventoryPolicy || v.inventory_policy;
      if (ip) gv.inventoryPolicy = ip;
      const rs = v.inventoryItem?.requiresShipping ?? v.requiresShipping;
      if (rs !== undefined) gv.requiresShipping = rs;
      else if (v.requires_shipping !== undefined) gv.requiresShipping = v.requires_shipping !== false;
      if (v.taxable !== undefined) gv.taxable = v.taxable;
      return gv;
    });

    let warnings = [];
    // ProductInput no longer accepts "options"/"variants" directly (see
    // product-variants.server.js) — productCreate only sets up options and a
    // single placeholder variant; productVariantsBulkCreate does the rest.
    const { id: productLegacyId, gid: productGid } = await createProductWithVariants({
      shopifyGraphql, shop: targetShop, token: targetToken, version,
      product: productInput, optionNames, variants: normalizedVariants,
    });

    // Images — handle both GraphQL edges format and REST src format. The
    // source store's own alt text (when present) is always preserved as-is
    // — AI generation (Phase 6) only fills in images that have none.
    let images = src.images?.edges
      ? src.images.edges.map((e) => ({ src: e.node?.url, alt: e.node?.altText || undefined })).filter((i) => i.src)
      : (src.images || []);
    if (altGen.enabled && images.some((i) => !i.alt)) {
      const generatedAlt = await altGen.generate({ title: src.title, description: src.descriptionHtml });
      if (generatedAlt) images = images.map((i) => (i.alt ? i : { ...i, alt: generatedAlt }));
    }
    const imageResult = await uploadProductImagesToTarget(productGid, images);
    if (imageResult.total && imageResult.uploaded < imageResult.total) {
      warnings.push(`Images copied ${imageResult.uploaded}/${imageResult.total}`);
      warnings.push(...imageResult.warnings.slice(0, 5));
    }

    if (sourceShopForMedia && sourceTokenForMedia) {
      const nonImageMedia = await fetchSourceProductNonImageMedia(sourceShopForMedia, sourceTokenForMedia, srcId);
      const mediaResult = await uploadProductMediaToTarget(productGid, nonImageMedia);
      if (mediaResult.total && mediaResult.uploaded < mediaResult.total) {
        warnings.push(`Product videos/3D media copied ${mediaResult.uploaded}/${mediaResult.total}`);
        warnings.push(...mediaResult.warnings.slice(0, 5));
      }
    }

    if (sourceShopForMedia && sourceTokenForMedia) {
      const mfResult = await copyProductMetafieldsToTarget(sourceShopForMedia, sourceTokenForMedia, srcId, productGid);
      if (mfResult.warnings.length) warnings.push(...mfResult.warnings.slice(0, 5));
    }

    // Phase 5: a newly created product is a record.
    const { limitReached } = await recordUsageAndCheck({ prisma, shop: targetShop, count: 1 });
    if (limitReached) quotaExceeded = true;

    return { id: productLegacyId, gid: productGid, warnings };
  }



  function compactObject(obj) {
    return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  }

  function normalizeHandle(value = "") {
    return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 255);
  }

  async function copyGraphqlMetafields({ sourceShop, sourceToken, sourceOwnerGid, targetOwnerGid }) {
    const warnings = [];
    let copied = 0;
    try {
      // Derive resource type from GID (e.g. gid://shopify/Product/123 → "product").
      // Bug fix: index 3 is the type segment; index 4 is the numeric ID
      // ("gid:","","shopify","Product","123") — the off-by-one meant this
      // built an invalid query field (the numeric ID itself), so every
      // metafield copy silently failed and was swallowed by the catch below.
      const resourceType = (sourceOwnerGid.split("/")[3] || "Product").toLowerCase();
      const query = `#graphql
        query Metafields($id: ID!) {
          ${resourceType}(id: $id) {
            metafields(first: 250) {
              edges { node { namespace key value type } }
            }
          }
        }`;
      const data = await shopifyGraphql(sourceShop, sourceToken, query, { id: sourceOwnerGid });
      const metafields = (data?.[resourceType]?.metafields?.edges || []).map((e) => e.node);
      if (!metafields.length) return { copied: 0, warnings };
      const mutation = `#graphql
        mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { namespace key }
            userErrors { field message code }
          }
        }`;
      for (let i = 0; i < metafields.length; i += 25) {
        const batch = metafields.slice(i, i + 25)
          .filter((mf) => mf?.namespace && mf?.key && mf.value !== undefined && mf.value !== null)
          .map((mf) => ({
            ownerId: targetOwnerGid,
            namespace: mf.namespace,
            key: mf.key,
            value: typeof mf.value === "string" ? mf.value : JSON.stringify(mf.value),
            type: mf.type,
          }));
        if (!batch.length) continue;
        // Truncated payload snapshot for debugging — capped so a huge
        // metafield value (e.g. rich-text JSON) can't blow up the warning.
        const payload = batch.map((b) => ({ namespace: b.namespace, key: b.key, type: b.type, value: String(b.value).slice(0, 200) }));
        try {
          const data = await shopifyGraphql(targetShop, targetToken, mutation, { metafields: batch });
          const set = data?.metafieldsSet?.metafields || [];
          const errors = data?.metafieldsSet?.userErrors || [];
          copied += set.length;
          if (errors.length) {
            const detail = errors.map((e) => `${e.field ? e.field.join(".") + ": " : ""}${e.message}${e.code ? ` [${e.code}]` : ""}`).join("; ");
            warnings.push(`Metafields rejected: ${detail} — payload: ${JSON.stringify(payload)}`);
          }
        } catch (err) {
          warnings.push(`Metafields batch failed: ${err.message} — payload: ${JSON.stringify(payload)}`);
        }
      }
    } catch (err) {
      warnings.push(`Metafields skipped: ${err.message}`);
    }
    return { copied, warnings };
  }

  async function copyProductMetafieldsToTarget(sourceShop, sourceToken, sourceProductId, targetProductGid) {
    return copyGraphqlMetafields({
      sourceShop, sourceToken,
      sourceOwnerGid: `gid://shopify/Product/${sourceProductId}`,
      targetOwnerGid: targetProductGid,
    });
  }

  function extractCdnFileRefsFromText(text = "") {
    const refs = new Map();
    const add = (raw) => {
      const filename = filenameFromUrlOrRef(raw);
      if (!filename || refs.has(filename)) return;
      refs.set(filename, { filename, original: raw });
    };
    const body = String(text || "");
    for (const m of body.matchAll(/shopify:\/\/shop_images\/([^"'\\\s,)]+[^"'\\\s,)]*)/g)) add(`shopify://shop_images/${m[1]}`);
    for (const m of body.matchAll(/https?:\/\/[^"'\\\s)]+\/cdn\/shop\/files\/([^"'\\\s)]+)/g)) add(m[0]);
    for (const m of body.matchAll(/https?:\/\/cdn\.shopify\.com\/s\/files\/[^"'\\\s)]*\/files\/([^"'\\\s)]+)/g)) add(m[0]);
    return [...refs.values()];
  }

  async function createFilesOnTargetFromRefs(sourceShop, refs, label = "content") {
    return createFilesOnTargetFromThemeRefs(sourceShop, targetShop, targetToken, refs).then((res) => ({ ...res, label }));
  }

  function fileNodeToOriginalSource(node = {}) {
    if (node.url) return node.url;
    if (node.image?.url) return node.image.url;
    if (Array.isArray(node.sources)) {
      const src = node.sources.find((s) => s?.url && /^https?:\/\//i.test(s.url));
      if (src) return src.url;
    }
    if (node.preview?.image?.url) return node.preview.image.url;
    return "";
  }

  async function fetchSourceFilesForCopy(sourceShop, sourceToken) {
    const query = `#graphql
      query StoreFiles($after: String) {
        files(first: 100, after: $after) {
          edges {
            cursor
            node {
              id
              alt
              fileStatus
              ... on MediaImage { image { url } }
              ... on GenericFile { url }
              ... on Video { sources { url mimeType format } }
              ... on Model3d { sources { url mimeType format } }
            }
          }
          pageInfo { hasNextPage }
        }
      }`;
    const files = [];
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await shopifyGraphql(sourceShop, sourceToken, query, { after });
      const edges = data?.files?.edges || [];
      for (const edge of edges) {
        const originalSource = fileNodeToOriginalSource(edge.node || {});
        if (!originalSource) continue;
        const filename = filenameFromUrlOrRef(originalSource);
        files.push({
          originalSource,
          filename,
          alt: edge.node?.alt || filename || "Imported file",
          contentType: mediaContentTypeFromUrl(originalSource),
        });
        after = edge.cursor;
      }
      hasNextPage = !!data?.files?.pageInfo?.hasNextPage;
    }
    return files;
  }

  async function copyStoreFiles(sourceShop, sourceToken, dryRun = false) {
    const out = { type: "files", title: "Shopify Files", status: "success", total: 0, copied: 0, skipped: 0, warnings: [] };
    try {
      const files = await fetchSourceFilesForCopy(sourceShop, sourceToken);
      const unique = new Map();
      for (const f of files) {
        const key = f.originalSource || f.filename;
        if (!unique.has(key)) unique.set(key, f);
      }
      let items = [...unique.values()];
      out.total = items.length;
      if (dryRun) { out.status = "dry-run"; return out; }

      // Idempotency: re-running a content transfer must not duplicate files
      // that are already on the destination. fetchSourceFilesForCopy is
      // shop-agnostic, so it doubles as a "list existing target files" call.
      try {
        const targetFiles = await fetchSourceFilesForCopy(targetShop, targetToken);
        const existingFilenames = new Set(targetFiles.map((f) => f.filename).filter(Boolean));
        const beforeDedupe = items.length;
        items = items.filter((f) => !existingFilenames.has(f.filename));
        out.skipped = beforeDedupe - items.length;
      } catch (err) {
        console.warn(`[importzo] copyStoreFiles: dedupe check failed, proceeding without it:`, err.message);
      }

      const mutation = `#graphql
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { id fileStatus alt ... on GenericFile { url } }
            userErrors { field message code }
          }
        }`;
      for (let i = 0; i < items.length; i += 100) {
        const batch = items.slice(i, i + 100).map((f) => compactObject({
          contentType: f.contentType,
          originalSource: f.originalSource,
          filename: f.filename,
          alt: f.alt,
        }));
        const data = await shopifyGraphql(targetShop, targetToken, mutation, { files: batch });
        const created = data?.fileCreate?.files || [];
        const errors = data?.fileCreate?.userErrors || [];
        out.copied += created.length;
        if (errors.length) out.warnings.push(...errors.map((e) => `${e.message}${e.field ? ` (${e.field.join(".")})` : ""}`));
        if (i + 100 < items.length) await new Promise((r) => setTimeout(r, 1000));
      }
      if (out.copied < items.length) out.status = "warning";
    } catch (err) {
      out.status = "warning";
      out.warnings.push(`Files copy skipped/failed: ${err.message}`);
    }
    return out;
  }

  async function findTargetPageByHandle(handle) {
    if (!handle) return null;
    try {
      const data = await shopifyGraphql(targetShop, targetToken, `#graphql
        query FindPage($query: String!) {
          pages(first: 1, query: $query) {
            edges { node { id handle title } }
          }
        }`, { query: `handle:${handle}` });
      return data?.pages?.edges?.[0]?.node || null;
    } catch { return null; }
  }

  function pagePayloadFromSource(src) {
    return compactObject({
      title: src.title || "Untitled page",
      body_html: src.body_html || "",
      handle: src.handle || normalizeHandle(src.title || "page"),
      published_at: src.published_at || null,
      template_suffix: src.template_suffix || undefined,
    });
  }

  async function upsertPageFromSource(sourceShop, sourceToken, src, dryRun = false, typeLabel = "page") {
    const title = src.title || "Untitled page";
    const result = { type: typeLabel, title, status: dryRun ? "dry-run" : "success", warnings: [] };
    if (dryRun) return result;
    try {
      const refs = extractCdnFileRefsFromText(src.body_html || src.body || "");
      if (refs.length) {
        const mediaRes = await createFilesOnTargetFromRefs(sourceShop, refs, "page-media");
        if (mediaRes.uploaded < mediaRes.total) result.warnings.push(`Embedded media copied ${mediaRes.uploaded}/${mediaRes.total}`);
      }

      const pageInput = {
        title: src.title || "Untitled page",
        body: src.body_html || src.body || "",
        handle: src.handle || normalizeHandle(src.title || "page"),
        isPublished: !!(src.published_at || src.publishedAt || src.isPublished),
      };
      if (src.template_suffix || src.templateSuffix) pageInput.templateSuffix = src.template_suffix || src.templateSuffix;

      const existing = await findTargetPageByHandle(src.handle);
      let newPageGid, newPageLegacyId;

      if (existing) {
        const data = await shopifyGraphql(targetShop, targetToken, `#graphql
          mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
            pageUpdate(id: $id, page: $page) {
              page { id }
              userErrors { field message }
            }
          }`, { id: existing.id, page: pageInput });
        const errors = data?.pageUpdate?.userErrors || [];
        if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
        newPageGid = data?.pageUpdate?.page?.id;
        newPageLegacyId = newPageGid ? String(newPageGid).split("/").pop() : null;
        result.warnings.push("Updated existing page with same handle");
      } else {
        const data = await shopifyGraphql(targetShop, targetToken, `#graphql
          mutation PageCreate($page: PageCreateInput!) {
            pageCreate(page: $page) {
              page { id }
              userErrors { field message }
            }
          }`, { page: pageInput });
        const errors = data?.pageCreate?.userErrors || [];
        if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
        newPageGid = data?.pageCreate?.page?.id;
        newPageLegacyId = newPageGid ? String(newPageGid).split("/").pop() : null;
      }

      if (newPageGid && src.id) {
        const srcPageGid = String(src.id).startsWith("gid://") ? src.id : `gid://shopify/Page/${src.id}`;
        const mf = await copyGraphqlMetafields({
          sourceShop, sourceToken,
          sourceOwnerGid: srcPageGid,
          targetOwnerGid: newPageGid,
        });
        if (mf.warnings.length) result.warnings.push(...mf.warnings.slice(0, 3));
      }
      result.newId = newPageLegacyId;
    } catch (err) {
      result.status = "error";
      result.error = err.message;
    }
    return result;
  }

  async function findTargetBlogByHandle(handle, targetBlogsCache) {
    if (!handle) return null;
    if (!targetBlogsCache.items) {
      try {
        const items = [];
        let after = null;
        let hasNextPage = true;
        const query = `#graphql
          query TargetBlogs($after: String) {
            blogs(first: 250, after: $after) {
              edges { node { id handle title } }
              pageInfo { hasNextPage endCursor }
            }
          }`;
        while (hasNextPage) {
          const data = await shopifyGraphql(targetShop, targetToken, query, { after });
          const edges = data?.blogs?.edges || [];
          items.push(...edges.map((e) => e.node));
          after = data?.blogs?.pageInfo?.endCursor;
          hasNextPage = !!data?.blogs?.pageInfo?.hasNextPage;
        }
        targetBlogsCache.items = items;
      } catch { targetBlogsCache.items = []; }
    }
    return targetBlogsCache.items.find((b) => b.handle === handle) || null;
  }

  function blogPayloadFromSource(src) {
    return compactObject({
      title: src.title || "Untitled blog",
      handle: src.handle || normalizeHandle(src.title || "blog"),
      commentPolicy: src.commentPolicy || undefined,
      template_suffix: src.template_suffix || undefined,
      tags: src.tags || undefined,
    });
  }

  function articlePayloadFromSource(src) {
    const payload = compactObject({
      title: src.title || "Untitled article",
      author: src.author?.name || src.author || undefined,
      body_html: src.body_html || "",
      summary_html: src.summary_html || undefined,
      handle: src.handle || normalizeHandle(src.title || "article"),
      tags: src.tags || undefined,
      published_at: src.published_at || null,
      template_suffix: src.template_suffix || undefined,
    });
    if (src.image?.src) payload.image = { src: src.image.src, alt: src.image.alt || undefined };
    return payload;
  }

  async function upsertBlogAndArticles(sourceShop, sourceToken, srcBlog, dryRun = false) {
    const result = { type: "blog", title: srcBlog.title || "Untitled blog", status: dryRun ? "dry-run" : "success", warnings: [], articleResults: [] };
    let sourceArticles = [];
    try {
      // srcBlog.id may be a GID (after GraphQL source fetch) or numeric string (legacy)
      const srcBlogGid = String(srcBlog.id || "").startsWith("gid://") ? srcBlog.id : `gid://shopify/Blog/${srcBlog.id}`;
      const articlesQuery = `#graphql
        query SourceBlogArticles($blogId: ID!, $after: String) {
          blog(id: $blogId) {
            articles(first: 50, after: $after) {
              edges { node {
                id
                title handle body tags
                author { name }
                isPublished publishedAt templateSuffix
                image { url altText }
              } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`;
      let artAfter = null;
      let artHasNext = true;
      while (artHasNext) {
        const artData = await shopifyGraphql(sourceShop, sourceToken, articlesQuery, { blogId: srcBlogGid, after: artAfter });
        const artEdges = artData?.blog?.articles?.edges || [];
        sourceArticles.push(...artEdges.map((e) => e.node));
        artAfter = artData?.blog?.articles?.pageInfo?.endCursor || null;
        artHasNext = !!artData?.blog?.articles?.pageInfo?.hasNextPage;
      }
    } catch (err) {
      result.status = "error";
      result.error = `Failed to fetch articles: ${err.message}`;
      return result;
    }
    result.totalArticles = sourceArticles.length;
    if (dryRun) return result;

    try {
      const targetBlogsCache = {};
      const existingBlog = await findTargetBlogByHandle(srcBlog.handle, targetBlogsCache);
      let targetBlogGid, targetBlogLegacyId;

      const blogInput = {
        title: srcBlog.title || "Untitled blog",
        handle: srcBlog.handle || normalizeHandle(srcBlog.title || "blog"),
      };
      if (srcBlog.commentPolicy) blogInput.commentPolicy = srcBlog.commentPolicy;
      if (srcBlog.template_suffix || srcBlog.templateSuffix) blogInput.templateSuffix = srcBlog.template_suffix || srcBlog.templateSuffix;

      if (existingBlog) {
        const data = await shopifyGraphql(targetShop, targetToken, `#graphql
          mutation BlogUpdate($id: ID!, $blog: BlogUpdateInput!) {
            blogUpdate(id: $id, blog: $blog) { blog { id } userErrors { field message } }
          }`, { id: existingBlog.id, blog: blogInput });
        const errs = data?.blogUpdate?.userErrors || [];
        if (errs.length) throw new Error(`Blog update: ${errs.map((e) => e.message).join("; ")}`);
        targetBlogGid = data?.blogUpdate?.blog?.id;
        targetBlogLegacyId = targetBlogGid ? String(targetBlogGid).split("/").pop() : null;
        result.warnings.push("Updated existing blog with same handle");
      } else {
        const data = await shopifyGraphql(targetShop, targetToken, `#graphql
          mutation BlogCreate($blog: BlogCreateInput!) {
            blogCreate(blog: $blog) { blog { id } userErrors { field message } }
          }`, { blog: blogInput });
        const errs = data?.blogCreate?.userErrors || [];
        if (errs.length) throw new Error(`Blog create: ${errs.map((e) => e.message).join("; ")}`);
        targetBlogGid = data?.blogCreate?.blog?.id;
        targetBlogLegacyId = targetBlogGid ? String(targetBlogGid).split("/").pop() : null;
      }
      result.newId = targetBlogLegacyId;
      if (!targetBlogGid) throw new Error("Destination blog API returned no ID");

      // Blog metafields
      const srcBlogGidForMf = String(srcBlog.id || "").startsWith("gid://") ? srcBlog.id : `gid://shopify/Blog/${srcBlog.id}`;
      const mf = await copyGraphqlMetafields({
        sourceShop, sourceToken,
        sourceOwnerGid: srcBlogGidForMf,
        targetOwnerGid: targetBlogGid,
      });
      if (mf.warnings.length) result.warnings.push(...mf.warnings.slice(0, 3));

      // Fetch existing articles on target blog
      let targetArticles = [];
      try {
        const targetArticlesQuery = `#graphql
          query TargetBlogArticles($blogId: ID!, $after: String) {
            blog(id: $blogId) {
              articles(first: 50, after: $after) {
                edges { node { id handle title } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`;
        let taAfter = null;
        let taHasNext = true;
        while (taHasNext) {
          const taData = await shopifyGraphql(targetShop, targetToken, targetArticlesQuery, { blogId: targetBlogGid, after: taAfter });
          const taEdges = taData?.blog?.articles?.edges || [];
          targetArticles.push(...taEdges.map((e) => e.node));
          taAfter = taData?.blog?.articles?.pageInfo?.endCursor || null;
          taHasNext = !!taData?.blog?.articles?.pageInfo?.hasNextPage;
        }
      } catch { targetArticles = []; }

      for (const article of sourceArticles) {
        const ar = { type: "article", title: article.title || "Untitled article", status: "success", warnings: [] };
        try {
          const refs = extractCdnFileRefsFromText(`${article.body || article.body_html || ""}\n${article.summaryHtml || article.summary_html || ""}`);
          if (refs.length) {
            const mediaRes = await createFilesOnTargetFromRefs(sourceShop, refs, "article-media");
            if (mediaRes.uploaded < mediaRes.total) ar.warnings.push(`Embedded media copied ${mediaRes.uploaded}/${mediaRes.total}`);
          }

          const articleInput = {
            title: article.title || "Untitled article",
            handle: article.handle || normalizeHandle(article.title || "article"),
            body: article.body || article.body_html || "",
            isPublished: !!(article.isPublished || article.published_at || article.publishedAt),
          };
          if (article.summaryHtml || article.summary_html) articleInput.summaryHtml = article.summaryHtml || article.summary_html;
          if (article.tags) articleInput.tags = Array.isArray(article.tags) ? article.tags : String(article.tags).split(",").map((t) => t.trim()).filter(Boolean);
          if (article.publishedAt || article.published_at) articleInput.publishedAt = article.publishedAt || article.published_at;
          if (article.templateSuffix || article.template_suffix) articleInput.templateSuffix = article.templateSuffix || article.template_suffix;
          if (article.author?.name) articleInput.author = article.author.name;
          if (article.image?.url || article.image?.src) articleInput.image = { src: article.image.url || article.image.src, altText: article.image.altText || article.image.alt || undefined };

          const existingArticle = targetArticles.find((a) => a.handle === article.handle);
          let newArticleGid, newArticleLegacyId;

          if (existingArticle) {
            const data = await shopifyGraphql(targetShop, targetToken, `#graphql
              mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
                articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } }
              }`, { id: existingArticle.id, article: articleInput });
            const errs = data?.articleUpdate?.userErrors || [];
            if (errs.length) throw new Error(`Article update: ${errs.map((e) => e.message).join("; ")}`);
            newArticleGid = data?.articleUpdate?.article?.id;
            newArticleLegacyId = newArticleGid ? String(newArticleGid).split("/").pop() : null;
            ar.warnings.push("Updated existing article with same handle");
          } else {
            const data = await shopifyGraphql(targetShop, targetToken, `#graphql
              mutation ArticleCreate($blogId: ID!, $article: ArticleCreateInput!) {
                articleCreate(blogId: $blogId, article: $article) { article { id } userErrors { field message } }
              }`, { blogId: targetBlogGid, article: articleInput });
            const errs = data?.articleCreate?.userErrors || [];
            if (errs.length) throw new Error(`Article create: ${errs.map((e) => e.message).join("; ")}`);
            newArticleGid = data?.articleCreate?.article?.id;
            newArticleLegacyId = newArticleGid ? String(newArticleGid).split("/").pop() : null;
          }
          ar.newId = newArticleLegacyId;

          if (newArticleGid) {
            const srcArticleGid = String(article.id || "").startsWith("gid://") ? article.id : `gid://shopify/Article/${article.id}`;
            const amf = await copyGraphqlMetafields({
              sourceShop, sourceToken,
              sourceOwnerGid: srcArticleGid,
              targetOwnerGid: newArticleGid,
            });
            if (amf.warnings.length) ar.warnings.push(...amf.warnings.slice(0, 2));
          }
        } catch (err) {
          ar.status = "error";
          ar.error = err.message;
        }
        result.articleResults.push(ar);
      }
      if (result.articleResults.some((a) => a.status === "error")) result.status = "warning";
    } catch (err) {
      result.status = "error";
      result.error = err.message;
    }
    return result;
  }

  const UNSUPPORTED_MENU_ITEM_TYPES = new Set(["CUSTOMER_ACCOUNT_PAGE"]);

  function isUnsupportedMenuItem(item = {}) {
    const type = String(item.type || "").toUpperCase();
    return UNSUPPORTED_MENU_ITEM_TYPES.has(type);
  }

  function filterMenuItems(items, skipped) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const item of items) {
      if (isUnsupportedMenuItem(item)) {
        skipped.push({ title: item.title || "Untitled", type: item.type, reason: "Unsupported link type — customer account pages are not transferable via API" });
        continue;
      }
      out.push({
        ...item,
        items: filterMenuItems(item.items, skipped),
      });
    }
    return out;
  }

  function menuItemForTarget(item = {}) {
    return compactObject({
      title: item.title || "Untitled",
      type: item.type || "HTTP",
      url: item.url || "#",
      tags: Array.isArray(item.tags) && item.tags.length ? item.tags : undefined,
      items: Array.isArray(item.items) ? item.items.map(menuItemForTarget).slice(0, 50) : [],
    });
  }

  function isCustomerAccountPageError(message = "") {
    const m = String(message).toLowerCase();
    return m.includes("customer_account_page") || m.includes("customer account page");
  }

  async function fetchSourceMenus(sourceShop, sourceToken) {
    const query = `#graphql
      query Menus($after: String) {
        menus(first: 100, after: $after) {
          edges {
            cursor
            node {
              id title handle isDefault
              items {
                title type url tags
                items { title type url tags items { title type url tags items { title type url tags } } }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`;
    const menus = [];
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await shopifyGraphql(sourceShop, sourceToken, query, { after });
      const edges = data?.menus?.edges || [];
      menus.push(...edges.map((e) => e.node));
      after = edges.length ? edges[edges.length - 1].cursor : null;
      hasNextPage = !!data?.menus?.pageInfo?.hasNextPage;
    }
    return menus;
  }

  async function fetchTargetMenus() {
    try {
      const data = await shopifyGraphql(targetShop, targetToken, `#graphql
        query TargetMenus($after: String) {
          menus(first: 100, after: $after) { edges { cursor node { id title handle isDefault } } pageInfo { hasNextPage } }
        }`, { after: null });
      return (data?.menus?.edges || []).map((e) => e.node);
    } catch { return []; }
  }

  async function upsertMenus(sourceShop, sourceToken, dryRun = false) {
    const result = { type: "menus", title: "Navigation menus", status: dryRun ? "dry-run" : "success", total: 0, copied: 0, warnings: [], results: [] };
    let sourceMenus = [];
    try {
      sourceMenus = await fetchSourceMenus(sourceShop, sourceToken);
      result.total = sourceMenus.length;
    } catch (err) {
      result.status = "warning";
      result.warnings.push(`Menus skipped: ${err.message}`);
      return result;
    }
    if (dryRun) return result;

    const targetMenus = await fetchTargetMenus();
    const createMutation = `#graphql
      mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
        menuCreate(title: $title, handle: $handle, items: $items) { menu { id handle } userErrors { field message code } }
      }`;
    const updateMutation = `#graphql
      mutation UpdateMenu($id: ID!, $title: String!, $handle: String, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, handle: $handle, items: $items) { menu { id handle } userErrors { field message code } }
      }`;

    for (const menu of sourceMenus) {
      const mr = { type: "menu", title: menu.title || menu.handle, status: "success", warnings: [] };
      try {
        const skipped = [];
        const filteredSource = filterMenuItems(menu.items || [], skipped);
        let items = filteredSource.map(menuItemForTarget).slice(0, 100);
        if (skipped.length) {
          mr.warnings.push(`Skipped ${skipped.length} unsupported link${skipped.length === 1 ? "" : "s"} (customer account pages cannot be transferred)`);
        }

        const runMutation = async () => {
          const existing = targetMenus.find((m) => m.handle === menu.handle);
          if (existing) {
            const variables = compactObject({ id: existing.id, title: menu.title || existing.title || menu.handle, handle: existing.isDefault ? undefined : menu.handle, items });
            const data = await shopifyGraphql(targetShop, targetToken, updateMutation, variables);
            const errs = data?.menuUpdate?.userErrors || [];
            if (errs.length) {
              const fatal = errs.filter((e) => !isCustomerAccountPageError(e.message));
              if (fatal.length) throw new Error(fatal.map((e) => e.message).join("; "));
              throw new Error(errs.map((e) => e.message).join("; "));
            }
            mr.warnings.push("Updated existing menu with same handle");
          } else {
            const data = await shopifyGraphql(targetShop, targetToken, createMutation, { title: menu.title || menu.handle, handle: menu.handle, items });
            const errs = data?.menuCreate?.userErrors || [];
            if (errs.length) {
              const fatal = errs.filter((e) => !isCustomerAccountPageError(e.message));
              if (fatal.length) throw new Error(fatal.map((e) => e.message).join("; "));
              throw new Error(errs.map((e) => e.message).join("; "));
            }
          }
        };

        try {
          await runMutation();
        } catch (err) {
          if (isCustomerAccountPageError(err.message)) {
            // Retry without any link the API still rejected as a customer account page.
            const retrySkipped = [];
            const stripCustomerAccount = (list) => {
              if (!Array.isArray(list)) return [];
              const out = [];
              for (const it of list) {
                const t = String(it.type || "").toUpperCase();
                const u = String(it.url || "").toLowerCase();
                if (t === "CUSTOMER_ACCOUNT_PAGE" || u.includes("customer_account") || u.includes("/account")) {
                  retrySkipped.push({ title: it.title, reason: "customer_account_page rejected by destination" });
                  continue;
                }
                out.push({ ...it, items: stripCustomerAccount(it.items) });
              }
              return out;
            };
            items = stripCustomerAccount(items);
            await runMutation();
            if (retrySkipped.length) mr.warnings.push(`Skipped ${retrySkipped.length} link${retrySkipped.length === 1 ? "" : "s"} the destination rejected as customer account pages`);
          } else {
            throw err;
          }
        }

        result.copied++;
      } catch (err) {
        mr.status = "error";
        mr.error = err.message;
        result.warnings.push(`${mr.title}: ${err.message}`);
      }
      result.results.push(mr);
    }
    if (result.results.some((r) => r.status === "error")) result.status = "warning";
    return result;
  }

  async function transferContentAndMedia(sourceShop, sourceToken, dryRun = false) {
    const results = [];
    const errors = [];

    const fileResult = await copyStoreFiles(sourceShop, sourceToken, dryRun);
    results.push(fileResult);

    try {
      const pagesQuery = `#graphql
        query SourcePages($after: String) {
          pages(first: 50, after: $after) {
            edges { node {
              id
              title handle body bodySummary isPublished publishedAt templateSuffix
              createdAt updatedAt
            } }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      const pages = [];
      let pAfter = null;
      let pHasNext = true;
      while (pHasNext) {
        const pData = await shopifyGraphql(sourceShop, sourceToken, pagesQuery, { after: pAfter });
        const pEdges = pData?.pages?.edges || [];
        pages.push(...pEdges.map((e) => e.node));
        pAfter = pData?.pages?.pageInfo?.endCursor || null;
        pHasNext = !!pData?.pages?.pageInfo?.hasNextPage;
      }
      if (dryRun) {
        results.push(...pages.map((page) => ({ type: "page", title: page.title || "Untitled page", status: "dry-run" })));
      } else {
        for (const page of pages) results.push(await upsertPageFromSource(sourceShop, sourceToken, page, false, "page"));
      }
    } catch (err) {
      errors.push(`Pages skipped: ${err.message}`);
    }

    try {
      const blogsQuery = `#graphql
        query SourceBlogs($after: String) {
          blogs(first: 50, after: $after) {
            edges { node {
              id title handle commentPolicy templateSuffix tags createdAt updatedAt
            } }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      const blogs = [];
      let bAfter = null;
      let bHasNext = true;
      while (bHasNext) {
        const bData = await shopifyGraphql(sourceShop, sourceToken, blogsQuery, { after: bAfter });
        const bEdges = bData?.blogs?.edges || [];
        blogs.push(...bEdges.map((e) => e.node));
        bAfter = bData?.blogs?.pageInfo?.endCursor || null;
        bHasNext = !!bData?.blogs?.pageInfo?.hasNextPage;
      }
      for (const blog of blogs) results.push(await upsertBlogAndArticles(sourceShop, sourceToken, blog, dryRun));
    } catch (err) {
      errors.push(`Blogs/articles skipped: ${err.message}`);
    }

    try {
      const policiesData = await shopifyGraphql(sourceShop, sourceToken, `#graphql
        query SourcePolicies {
          shop {
            shopPolicies {
              id
              title
              body
              type
              url
              createdAt
              updatedAt
            }
          }
        }`);
      const policies = policiesData?.shop?.shopPolicies || [];
      for (const policy of policies.filter((p) => p?.body)) {
        const policyHandle = (policy.type || policy.title || "imported").toString().toLowerCase().replace(/_/g, "-");
        const page = {
          id: null,
          title: `Policy - ${policy.title || policy.type || "Imported"}`,
          handle: normalizeHandle(`policy-${policyHandle}`),
          body_html: policy.body || "",
          published_at: new Date().toISOString(),
        };
        const pr = await upsertPageFromSource(sourceShop, sourceToken, page, dryRun, "policy-page");
        if (!dryRun) pr.warnings = [...(pr.warnings || []), "Shopify policies are read-only through API, so this policy was copied as a normal page."];
        results.push(pr);
      }
    } catch (err) {
      errors.push(`Policies skipped: ${err.message}`);
    }

    const menuResult = await upsertMenus(sourceShop, sourceToken, dryRun);
    results.push(menuResult);

    for (const e of errors) results.push({ type: "content", title: e, status: "warning", warnings: [e] });

    const flat = results.flatMap((r) => r.type === "blog" ? [r, ...(r.articleResults || [])] : [r, ...(r.results || [])]);
    const total = flat.length;
    const success = flat.filter((r) => r.status === "success" || r.status === "warning").length;
    const failed = flat.filter((r) => r.status === "error").length;
    const warnings = flat.filter((r) => r.status === "warning" || (r.warnings && r.warnings.length)).length;

    // Phase 5: count only genuinely created/updated objects — NOT the
    // `success`/`warning` stat above, which folds in rollup entries
    // (fileResult, menuResult) that report status "success" even when they
    // moved zero real objects (e.g. a store with no menus at all still
    // yields one "menus: success, 0 copied" entry). Pages/blogs/articles
    // have no such rollup — one flat entry IS one real object — but
    // files/menus need their own `copied` count instead of their status.
    // This whole helper runs to completion in a single request/response
    // cycle, so there's no natural per-item checkpoint to stop early —
    // usage is recorded once, in a batch, after the fact.
    const contentRecords =
      flat.filter((r) => ["page", "policy-page", "blog", "article"].includes(r.type) && (r.status === "success" || r.status === "warning")).length
      + (fileResult.copied || 0)
      + (menuResult.copied || 0);
    if (!dryRun && contentRecords > 0) {
      await recordUsageAndCheck({ prisma, shop: targetShop, count: contentRecords });
    }

    return { intent: "transfer-content", rid, ok: failed === 0, total, success, failed, warnings, results };
  }

  // ── Connect & verify source store ──
  if (intent === "connect") {
    const { url, token } = await getSourceCreds();
    if (!url) return { intent: "connect", rid, ok: false, error: "Please enter your source store URL" };
    if (!token) return { intent: "connect", rid, ok: false, error: "Please enter the Admin API access token" };

    try {
      const connCtrl = new AbortController();
      const connTimeout = setTimeout(() => connCtrl.abort(), 20000);
      let gqlRes;
      try {
        gqlRes = await fetch(`https://${url}/admin/api/${version}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query: `{ shop { name email plan { displayName } } productsCount { count } collectionsCount { count } }` }),
          signal: connCtrl.signal,
        });
      } finally {
        clearTimeout(connTimeout);
      }
      if (gqlRes.status === 401 || gqlRes.status === 403) throw new Error("Invalid access token. Make sure you copied the full token starting with shpat_");
      if (gqlRes.status === 404) throw new Error("Store not found. Check the URL.");
      if (!gqlRes.ok) throw new Error(`Connection failed (HTTP ${gqlRes.status}).`);
      const gqlData = (await gqlRes.json())?.data || {};
      const shopName = gqlData.shop?.name || url;
      const shopEmail = gqlData.shop?.email || "";
      const shopPlan = gqlData.shop?.plan?.displayName || "";
      const productCount = gqlData.productsCount?.count ?? 0;
      const collectionCount = gqlData.collectionsCount?.count ?? 0;

      // Themes are exempt — still use REST themes.json
      const fetchWithTimeout = (reqUrl, opts, ms) => {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), ms);
        return fetch(reqUrl, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
      };
      const tc = await fetchWithTimeout(`https://${url}/admin/api/${THEME_API_VERSION}/themes.json`, { headers: { "X-Shopify-Access-Token": token } }, 10000).catch(() => ({ ok: false }));
      let themeCount = 0;
      let themes = [];
      if (tc.ok) { const td = await tc.json(); themes = td.themes || []; themeCount = themes.length; }

      // Phase 4.2: Markets, best-effort. A source token that predates the
      // read_markets scope (not yet re-authorized) must not break the whole
      // connect flow — the transfer UI just shows no market filter option.
      const marketsResult = await listMarkets({ shopifyGraphql: sharedShopifyGraphql, shop: url, token, version }).catch(() => ({ ok: false, markets: [] }));

      // Save connection to DB (best-effort — never blocks the user)
      const saveToken = formData.get("sourceToken")?.trim() || token;
      await upsertSourceStore(session.shop, {
        sourceUrl: url, sourceName: shopName, sourceEmail: shopEmail, sourcePlan: shopPlan, token: saveToken,
      });

      return {
        intent: "connect", rid, ok: true,
        shopName, shopEmail, shopPlan, shopDomain: url,
        productCount, collectionCount, themeCount, themes,
        markets: marketsResult.markets,
      };
    } catch (err) {
      return { intent: "connect", rid, ok: false, error: err.message };
    }
  }

  // ── Verify saved connection ──
  if (intent === "verify-connection") {
    const saved = await getSavedSourceStore(session.shop);
    if (!saved) return { intent: "verify-connection", rid, ok: false, error: "No saved connection found. Please enter your source store credentials to continue." };

    try {
      const vCtrl = new AbortController();
      const vTimeout = setTimeout(() => vCtrl.abort(), 20000);
      let vGqlRes;
      try {
        vGqlRes = await fetch(`https://${saved.sourceUrl}/admin/api/${version}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": saved.token },
          body: JSON.stringify({ query: `{ shop { name email plan { displayName } } productsCount { count } collectionsCount { count } }` }),
          signal: vCtrl.signal,
        });
      } finally {
        clearTimeout(vTimeout);
      }
      if (!vGqlRes.ok) throw new Error("Saved credentials are no longer valid. Please reconnect your source store.");
      await touchSourceStore(session.shop);

      const vGqlData = (await vGqlRes.json())?.data || {};
      const productCount = vGqlData.productsCount?.count ?? 0;
      const collectionCount = vGqlData.collectionsCount?.count ?? 0;

      // Themes are exempt — still use REST themes.json
      const fetchWithTimeout2 = (reqUrl, opts, ms) => {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), ms);
        return fetch(reqUrl, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
      };
      const tc = await fetchWithTimeout2(`https://${saved.sourceUrl}/admin/api/${THEME_API_VERSION}/themes.json`, { headers: { "X-Shopify-Access-Token": saved.token } }, 10000).catch(() => ({ ok: false }));
      let themeCount = 0;
      let themes = [];
      if (tc.ok) { const td = await tc.json(); themes = td.themes || []; themeCount = themes.length; }

      const marketsResult = await listMarkets({ shopifyGraphql: sharedShopifyGraphql, shop: saved.sourceUrl, token: saved.token, version }).catch(() => ({ ok: false, markets: [] }));

      return {
        intent: "verify-connection", rid, ok: true,
        shopName: saved.sourceName, shopEmail: saved.sourceEmail, shopPlan: saved.sourcePlan, shopDomain: saved.sourceUrl,
        productCount, collectionCount, themeCount, themes,
        markets: marketsResult.markets,
      };
    } catch (err) {
      return { intent: "verify-connection", rid, ok: false, error: err.message };
    }
  }

  // ── Disconnect ──
  if (intent === "disconnect") {
    await deleteSourceStore(session.shop);
    return { intent: "disconnect", rid, ok: true };
  }

  // ── Fetch collections from source ──
  if (intent === "fetch-collections") {
    try {
      const { url, token } = await getSourceCreds();
      if (!url || !token) {
        console.error("[importzo] fetch-collections: missing source credentials", { hasUrl: !!url, hasToken: !!token });
        return { intent: "fetch-collections", rid, ok: false, error: "Missing source store credentials. Please reconnect your source store." };
      }
      // Logs that the credential is PRESENT, never anything about its value.
      // This used to emit tokenLen and tokenPrefix. The prefix was harmless in
      // practice (it is always the literal "shpat_"), but length plus prefix is
      // still credential metadata written to a log file for no operational
      // benefit — the probe below is what actually diagnoses a bad token, and
      // it does so by outcome.
      console.log(`[importzo] fetch-collections: source=${url} hasToken=${!!token}`);

      // Sanity probe: count via dedicated count query — exposes scope/auth issues fast.
      try {
        const probe = await shopifyGraphql(url, token, `{ collectionsCount { count } productsCount { count } }`);
        console.log(`[importzo] fetch-collections probe: collectionsCount=${probe?.collectionsCount?.count} productsCount=${probe?.productsCount?.count}`);
      } catch (probeErr) {
        console.error(`[importzo] fetch-collections probe failed: ${probeErr.message}`);
        return { intent: "fetch-collections", rid, ok: false, error: `Source store is not reachable: ${probeErr.message}` };
      }

      const collections = [];
      const colQuery = `#graphql
        query FetchCollections($after: String) {
          collections(first: 250, after: $after) {
            edges { cursor node {
                      id
              title handle descriptionHtml sortOrder
              image { url }
              ruleSet { appliedDisjunctively rules { column relation condition } }
              productsCount { count }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      let colAfter = null;
      let colHasNext = true;
      while (colHasNext) {
        const colData = await shopifyGraphql(url, token, colQuery, { after: colAfter });
        const colEdges = colData?.collections?.edges || [];
        if (colEdges.length === 0 && collections.length === 0) {
          console.warn(`[importzo] fetch-collections: first page returned 0 edges. raw=${JSON.stringify(colData).slice(0, 400)}`);
        }
        for (const edge of colEdges) {
          const c = edge.node;
          const isSmart = !!c.ruleSet;
          const entry = {
            id: c.id.split("/").pop(),
            gid: c.id,
            title: c.title,
            handle: c.handle,
            body_html: c.descriptionHtml || "",
            image: c.image?.url || "",
            published: true,
            sort_order: c.sortOrder || "",
            type: isSmart ? "smart" : "custom",
            productCount: c.productsCount?.count ?? 0,
          };
          if (isSmart) {
            entry.rules = (c.ruleSet.rules || []).map((r) => ({
              column: r.column.toLowerCase(),
              relation: r.relation.toLowerCase(),
              condition: r.condition,
            }));
            entry.disjunctive = c.ruleSet.appliedDisjunctively;
          }
          collections.push(entry);
        }
        colAfter = colData?.collections?.pageInfo?.endCursor || null;
        colHasNext = !!colData?.collections?.pageInfo?.hasNextPage;
      }
      console.log(`[importzo] fetch-collections: returning ${collections.length} collection(s)`);
      return { intent: "fetch-collections", rid, ok: true, collections };
    } catch (err) {
      console.error(`[importzo] fetch-collections error: ${err.message}`);
      return { intent: "fetch-collections", rid, ok: false, error: err.message };
    }
  }

  // ── Helper: fetch all products in a source collection via GraphQL ──
  async function fetchSourceCollectionProducts(sourceShop, sourceToken, colGid) {
    const query = `#graphql
      query SourceCollectionProducts($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            edges { cursor node {
              id title handle
              descriptionHtml vendor productType tags status publishedAt
              options { name }
              images(first: 250) { edges { node { url altText } } }
              variants(first: 100) { edges { node {
                title sku price compareAtPrice barcode
                inventoryItem { measurement { weight { value unit } } }
                taxable
                selectedOptions { name value }
              } } }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`;
    const products = [];
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await shopifyGraphql(sourceShop, sourceToken, query, { id: colGid, after });
      const edges = data?.collection?.products?.edges || [];
      products.push(...edges.map((e) => e.node));
      after = edges.length ? edges[edges.length - 1].cursor : null;
      hasNextPage = !!data?.collection?.products?.pageInfo?.hasNextPage;
    }
    return products;
  }

  // ── Helper: fetch all products from a source store via GraphQL ──
  async function fetchSourceProducts(sourceShop, sourceToken) {
    const query = `#graphql
      query SourceProducts($after: String) {
        products(first: 250, after: $after) {
          edges { cursor node {
            id title handle
            descriptionHtml vendor productType tags status publishedAt
            options { name }
            images(first: 250) { edges { node { url altText } } }
            variants(first: 100) { edges { node {
              title sku price compareAtPrice barcode
              inventoryItem { measurement { weight { value unit } } }
              taxable
              selectedOptions { name value }
            } } }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`;
    const products = [];
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await shopifyGraphql(sourceShop, sourceToken, query, { after });
      const edges = data?.products?.edges || [];
      products.push(...edges.map((e) => e.node));
      after = edges.length ? edges[edges.length - 1].cursor : null;
      hasNextPage = !!data?.products?.pageInfo?.hasNextPage;
    }
    return products;
  }

  // Enum maps for collection create
  const SORT_ORDER_MAP = { manual: "MANUAL", "best-selling": "BEST_SELLING", "alpha-asc": "ALPHA_ASC", "alpha-desc": "ALPHA_DESC", "price-desc": "PRICE_DESC", "price-asc": "PRICE_ASC", created: "CREATED", "created-desc": "CREATED_DESC" };
  const RULE_COLUMN_MAP = { tag: "TAG", title: "TITLE", type: "TYPE", vendor: "VENDOR", variant_title: "VARIANT_TITLE", variant_price: "VARIANT_PRICE" };
  const RULE_RELATION_MAP = { equals: "EQUALS", not_equals: "NOT_EQUALS", greater_than: "GREATER_THAN", less_than: "LESS_THAN", starts_with: "STARTS_WITH", ends_with: "ENDS_WITH", contains: "CONTAINS", not_contains: "NOT_CONTAINS" };

  const COLLECTION_CREATE_MUTATION = `#graphql
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id }
        userErrors { field message }
      }
    }`;

  // ── Transfer ONE collection with ALL its products ──
  if (intent === "transfer") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    let col;
    try {
      const rawCol = formData.get("collection");
      if (!rawCol) return { intent: "transfer", rid, ok: false, error: "Missing collection data" };
      col = JSON.parse(rawCol);
    } catch {
      return { intent: "transfer", rid, ok: false, error: "Invalid collection data" };
    }
    const dryRun = formData.get("dryRun") === "true";
    const out = { collectionId: col.id, collectionTitle: col.title, collectionType: col.type, newCollectionId: null, collectionWarning: null, collectionError: null, products: [] };

    if (dryRun) {
      // Dry run — count products without creating anything
      try {
        const collectionGid = col.gid || `gid://shopify/Collection/${col.id}`;
        const dryProducts = await fetchSourceCollectionProducts(sourceUrl, sourceToken, collectionGid);
        out.products = dryProducts.map((p) => ({ sourceId: p.id.split("/").pop(), title: p.title, status: "dry-run", error: null, warnings: [] }));
      } catch (err) { out.collectionError = err.message; }
      return { intent: "transfer", rid, ok: true, result: out };
    }

    try {
      const input = {
        title: col.title,
        descriptionHtml: col.body_html || "",
        sortOrder: SORT_ORDER_MAP[(col.sort_order || "").toLowerCase()] || "MANUAL",
      };
      if (col.image) input.image = { src: col.image };
      if (col.type === "smart") {
        const rawRules = col.rules?.length > 0 ? col.rules : [{ column: "tag", relation: "equals", condition: col.title || "imported" }];
        input.ruleSet = {
          appliedDisjunctively: !!col.disjunctive,
          rules: rawRules.map((r) => ({
            column: RULE_COLUMN_MAP[r.column?.toLowerCase()] || r.column?.toUpperCase() || "TAG",
            relation: RULE_RELATION_MAP[r.relation?.toLowerCase()] || r.relation?.toUpperCase() || "EQUALS",
            condition: r.condition,
          })),
        };
      }

      let colGqlData = await shopifyGraphql(targetShop, targetToken, COLLECTION_CREATE_MUTATION, { input });
      let colErrors = colGqlData?.collectionCreate?.userErrors || [];
      if (colErrors.length && col.image) {
        delete input.image;
        out.collectionWarning = "Collection image skipped";
        colGqlData = await shopifyGraphql(targetShop, targetToken, COLLECTION_CREATE_MUTATION, { input });
        colErrors = colGqlData?.collectionCreate?.userErrors || [];
      }
      if (colErrors.length) throw new Error(colErrors.map((e) => e.message).join("; "));
      const newColNode = colGqlData?.collectionCreate?.collection;
      if (!newColNode?.id) throw new Error("Collection creation failed: API returned no ID");
      const newColGid = newColNode.id;
      const newColId = newColNode.id.split("/").pop();

      out.newCollectionId = newColId;

      // Phase 5: the collection itself is a record, separate from the
      // products transferred into it below.
      {
        const { limitReached } = await recordUsageAndCheck({ prisma, shop: targetShop, count: 1 });
        if (limitReached) quotaExceeded = true;
      }

      try {
        const mfResult = await copyGraphqlMetafields({
          sourceShop: sourceUrl, sourceToken,
          sourceOwnerGid: col.gid || `gid://shopify/Collection/${col.id}`,
          targetOwnerGid: newColGid,
        });
        if (mfResult.warnings.length) out.collectionWarning = `Collection metafields: ${mfResult.warnings.slice(0, 3).join("; ")}`;
      } catch (_) { /* non-fatal */ }

      const collectionGid = col.gid || `gid://shopify/Collection/${col.id}`;
      const sourceProducts = await fetchSourceCollectionProducts(sourceUrl, sourceToken, collectionGid);
      // Parallel transfer: batches of 10
      const TRANSFER_BATCH = 10;
      for (let _bi = 0; _bi < sourceProducts.length; _bi += TRANSFER_BATCH) {
        // Phase 5: once the plan limit is hit mid-transfer, stop creating new
        // products — the rest of this batch and any later ones are reported
        // as skipped rather than silently attempted.
        if (quotaExceeded) {
          out.products.push(...sourceProducts.slice(_bi).map((src) => ({
            sourceId: src.id.split("/").pop(), title: src.title, status: "error",
            error: "Skipped — plan limit reached (upgrade to continue)", warnings: [],
          })));
          break;
        }
        const batch = sourceProducts.slice(_bi, _bi + TRANSFER_BATCH);
        const batchOut = await Promise.all(batch.map(async (src) => {
          const pr = { sourceId: src.id.split("/").pop(), title: src.title, status: "success", error: null, warnings: [] };
          try {
            const { id: newId, gid: newGid, warnings } = await createProductOnTarget(src, sourceUrl, sourceToken);
            pr.newProductId = newId;
            pr.warnings = warnings;
            if (col.type !== "smart" && newColGid) {
              try {
                const addData = await shopifyGraphql(targetShop, targetToken, `#graphql
                  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
                    collectionAddProducts(id: $id, productIds: $productIds) {
                      job { id done }
                      userErrors { field message }
                    }
                  }`, { id: newColGid, productIds: [newGid || `gid://shopify/Product/${newId}`] });
                const addErrors = addData?.collectionAddProducts?.userErrors || [];
                if (addErrors.length) pr.warnings.push("Could not link to collection");
              } catch (_) { pr.warnings.push("Collection link failed"); }
            }
          } catch (err) { pr.status = "error"; pr.error = err.message; }
          return pr;
        }));
        out.products.push(...batchOut);
      }
    } catch (err) { out.collectionError = err.message; }
    return { intent: "transfer", rid, ok: true, result: out };
  }

  // ── Transfer standalone products (not in any collection) ──
  if (intent === "transfer-products") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    const dryRun = formData.get("dryRun") === "true";
    const skipCollectionProducts = formData.get("skipCollectionProducts") === "true";

    if (!sourceUrl || !sourceToken) {
      console.error("[importzo] transfer-products: missing source credentials", { hasUrl: !!sourceUrl, hasToken: !!sourceToken });
      return { intent: "transfer-products", rid, ok: false, error: "Missing source store credentials. Please reconnect your source store." };
    }
    // Presence only — see the note on the fetch-collections log above.
    console.log(`[importzo] transfer-products: source=${sourceUrl} hasToken=${!!sourceToken} dryRun=${dryRun} skipCollectionProducts=${skipCollectionProducts}`);

    // Sanity probe: count via dedicated count query — exposes scope/auth issues fast.
    try {
      const probe = await shopifyGraphql(sourceUrl, sourceToken, `{ productsCount { count } }`);
      console.log(`[importzo] transfer-products probe: productsCount=${probe?.productsCount?.count}`);
    } catch (probeErr) {
      console.error(`[importzo] transfer-products probe failed: ${probeErr.message}`);
      return { intent: "transfer-products", rid, ok: false, error: `Source store is not reachable: ${probeErr.message}` };
    }

    try {
      const allProducts = await fetchSourceProducts(sourceUrl, sourceToken);
      console.log(`[importzo] transfer-products: fetched ${allProducts.length} product(s) from source`);
      let productsToTransfer = allProducts;

      if (skipCollectionProducts) {
        const collProductIds = new Set();
        const colQuery = `#graphql
          query SourceCollections($after: String) {
            collections(first: 250, after: $after) {
              edges { cursor node { id } }
              pageInfo { hasNextPage endCursor }
            }
          }`;
        const allCols = [];
        let cAfter = null;
        let cHasNextPage = true;
        while (cHasNextPage) {
          const colData = await shopifyGraphql(sourceUrl, sourceToken, colQuery, { after: cAfter });
          const cEdges = colData?.collections?.edges || [];
          allCols.push(...cEdges.map((e) => e.node));
          cAfter = cEdges.length ? cEdges[cEdges.length - 1].cursor : null;
          cHasNextPage = !!colData?.collections?.pageInfo?.hasNextPage;
        }
        for (const col of allCols) {
          try {
            const prods = await fetchSourceCollectionProducts(sourceUrl, sourceToken, col.id);
            prods.forEach((p) => collProductIds.add(p.id));
          } catch (_) {}
        }
        productsToTransfer = allProducts.filter((p) => !collProductIds.has(p.id));
      }

      if (dryRun) {
        // Phase 6 — fuzzy duplicate detection, advisory only: never blocks
        // or changes the preview, just annotates rows with a
        // `similarTo` hint the merchant can act on (skip / create anyway /
        // merge). Runs automatically whenever this shop has an AI
        // integration configured — dry-run is already an explicit opt-in
        // action, and nothing is written either way, so there's no
        // separate toggle for this the way there is for alt-text
        // generation (which runs on real writes).
        const similarByTitle = new Map();
        try {
          const integration = await getAiIntegrationForUse({ prisma, shop: targetShop });
          if (integration) {
            let allowed = true;
            if (integration.provider === "groq_builtin") {
              const gate = await assertAiQuotaAvailable({ prisma, shop: targetShop });
              allowed = gate.ok;
            }
            if (allowed) {
              const existingTitles = await fetchExistingProductTitles();
              if (existingTitles.length) {
                const result = await detectSimilarProducts({
                  provider: integration.provider, apiKey: integration.apiKey, model: integration.model,
                  incomingTitles: productsToTransfer.map((p) => p.title), existingTitles,
                });
                if (result.ok) {
                  if (integration.provider === "groq_builtin") await recordAiUsage({ prisma, shop: targetShop });
                  for (const m of result.matches) similarByTitle.set(m.incomingTitle, m.existingTitle);
                }
              }
            }
          }
        } catch (err) {
          // Best-effort — a failed similarity check must never break the
          // dry-run preview itself.
          console.warn(`[importzo] duplicate detection failed: ${err.message}`);
        }

        return {
          intent: "transfer-products", rid, ok: true, total: allProducts.length, transferred: productsToTransfer.length,
          results: productsToTransfer.map((p) => ({
            title: p.title, status: "dry-run",
            ...(similarByTitle.has(p.title) ? { similarTo: similarByTitle.get(p.title) } : {}),
          })),
        };
      }

      const results = [];
      // Parallel transfer: batches of 10
      const TRANSFER_BATCH = 10;
      for (let _bi = 0; _bi < productsToTransfer.length; _bi += TRANSFER_BATCH) {
        // Phase 5: see the matching comment in the "transfer" intent above.
        if (quotaExceeded) {
          results.push(...productsToTransfer.slice(_bi).map((src) => ({
            title: src.title, status: "error", error: "Skipped — plan limit reached (upgrade to continue)",
          })));
          break;
        }
        const batch = productsToTransfer.slice(_bi, _bi + TRANSFER_BATCH);
        const batchOut = await Promise.all(batch.map(async (src) => {
          try {
            const { warnings } = await createProductOnTarget(src, sourceUrl, sourceToken);
            return { title: src.title, status: "success", warnings };
          } catch (err) {
            return { title: src.title, status: "error", error: err.message };
          }
        }));
        results.push(...batchOut);
      }
      return { intent: "transfer-products", rid, ok: true, total: allProducts.length, transferred: productsToTransfer.length, results };
    } catch (err) {
      console.error(`[importzo] transfer-products error: ${err.message}`);
      return { intent: "transfer-products", rid, ok: false, error: err.message };
    }
  }

  // ── Transfer theme ──
  if (intent === "transfer-theme") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    const rawThemeId = (formData.get("themeId") || "").trim();
    // Validate themeId is a positive integer to prevent path traversal in API URLs
    if (!/^\d+$/.test(rawThemeId)) {
      return { intent: "transfer-theme", rid, ok: false, error: "Invalid theme ID" };
    }
    const themeId = rawThemeId;
    const rawThemeName = formData.get("themeName") || "Transferred Theme";
    // Limit theme name length to prevent excessively large API payloads
    const themeName = rawThemeName.slice(0, 200);
    const dryRun = formData.get("dryRun") === "true";

    try {
      // Fetch all assets from source theme (with retry)
      const assetsRes = await shopifyFetch(`https://${sourceUrl}/admin/api/${THEME_API_VERSION}/themes/${themeId}/assets.json`, { headers: { "X-Shopify-Access-Token": sourceToken } });
      if (!assetsRes.ok) throw new Error(`Failed to fetch theme assets: HTTP ${assetsRes.status}`);
      const assetsList = (await assetsRes.json()).assets || [];

      if (dryRun) {
        // Dry run: never touch the destination store. Count assets only.
        return {
          intent: "transfer-theme", rid, ok: true, dryRun: true,
          themeName, assetCount: assetsList.length,
          message: `${assetsList.length} assets would be transferred`,
          results: assetsList.map((a) => ({ key: a.key, status: "dry-run" })),
        };
      }

      // Verify source token before starting the package build. A 401 mid-transfer
      // creates confusing partial ZIP errors, so fail fast here.
      try {
        await shopifyGraphql(sourceUrl, sourceToken, `{ shop { name } }`);
      } catch (err) {
        if (/401|403|unauthorized|forbidden/i.test(err.message)) {
          throw new Error("Source store session expired or the app was uninstalled from the source store. Please reconnect the source store using a new session code.");
        }
        throw err;
      }

      // Idempotency: theme creation has no natural "update" path via the ZIP-src
      // flow, so re-running this transfer (e.g. after a timeout, or a merchant
      // double-clicking) would otherwise create another full duplicate theme
      // every time, eventually hitting the destination store's theme-count limit.
      // Skip if a theme with the same generated name already exists.
      const expectedThemeName = `${themeName} (Transferred)`;
      try {
        const existingThemesRes = await shopifyFetch(`https://${targetShop}/admin/api/${THEME_API_VERSION}/themes.json`, {
          headers: { "X-Shopify-Access-Token": targetToken },
        });
        if (existingThemesRes.ok) {
          const existingThemes = (await existingThemesRes.json()).themes || [];
          const match = existingThemes.find((t) => t.name === expectedThemeName);
          if (match) {
            return {
              intent: "transfer-theme", rid, ok: true, skipped: true,
              themeName, themeId: match.id, newThemeId: match.id, newThemeName: match.name,
              previewUrl: `https://${targetShop}/?preview_theme_id=${match.id}`,
              assetCount: assetsList.length,
              results: [],
              message: `A theme named "${expectedThemeName}" already exists on the destination store — skipped to avoid creating a duplicate.`,
              destinationAdminUrl: `https://${targetShop.replace(/\.myshopify\.com$/i, "")}.myshopify.com/admin/themes`,
            };
          }
        }
      } catch (err) {
        console.warn(`[importzo] transfer-theme: existing-theme check failed, proceeding with creation:`, err.message);
      }

      // IMPORTANT: Do not create an empty theme and then PUT layout/theme.liquid.
      // Shopify's supported theme creation flow is to provide a public ZIP URL in
      // theme.src. REST Asset PUT is protected/restricted and commonly returns
      // 404 even when theme reads work. So we package the source theme as a ZIP,
      // expose it through a short-lived public route, then let Shopify create the
      // destination theme from that ZIP.
      const zipFiles = [];
      const results = [];

      const fetchAssetForZip = async (asset) => {
        const getController = new AbortController();
        const getTimeout = setTimeout(() => getController.abort(), 30000);
        let assetRes;
        try {
          assetRes = await shopifyFetch(
            `https://${sourceUrl}/admin/api/${THEME_API_VERSION}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`,
            { headers: { "X-Shopify-Access-Token": sourceToken }, signal: getController.signal }
          );
        } finally {
          clearTimeout(getTimeout);
        }

        if (assetRes.status === 401) {
          throw new Error("Source store session expired while reading theme files. Please reconnect the source store and try again.");
        }
        if (!assetRes.ok) {
          throw new Error(`Failed to read source asset ${asset.key}: HTTP ${assetRes.status}`);
        }

        const assetData = (await assetRes.json()).asset;
        if (!assetData) {
          throw new Error(`Empty source response for asset ${asset.key}`);
        }

        let data;
        if (assetData.value !== undefined && assetData.value !== null) {
          data = Buffer.from(assetData.value, "utf8"); // eslint-disable-line no-undef
        } else if (assetData.attachment) {
          data = Buffer.from(assetData.attachment, "base64"); // eslint-disable-line no-undef
        } else if (assetData.public_url) {
          const cdnCtrl = new AbortController();
          const cdnTout = setTimeout(() => cdnCtrl.abort(), 30000);
          try {
            const cdnRes = await fetch(assetData.public_url, { signal: cdnCtrl.signal });
            if (!cdnRes.ok) throw new Error(`CDN HTTP ${cdnRes.status}`);
            data = Buffer.from(await cdnRes.arrayBuffer()); // eslint-disable-line no-undef
          } finally {
            clearTimeout(cdnTout);
          }
        } else {
          results.push({ key: asset.key, status: "warning", error: "No readable asset content returned by Shopify" });
          return;
        }

        zipFiles.push({ name: asset.key, data });
        results.push({ key: asset.key, status: "success" });
      };

      // Fetch source assets in small batches. Building the ZIP server-side avoids
      // hundreds of destination Asset PUT calls and removes the layout/theme.liquid
      // 404 failure path completely.
      const PACKAGE_BATCH = 8;
      for (let i = 0; i < assetsList.length; i += PACKAGE_BATCH) {
        const slice = assetsList.slice(i, i + PACKAGE_BATCH);
        await Promise.all(slice.map(fetchAssetForZip));
        if (i + PACKAGE_BATCH < assetsList.length) {
          await new Promise(r => setTimeout(r, 250));
        }
      }

      if (!zipFiles.some((file) => file.name === "layout/theme.liquid")) {
        throw new Error("Source theme does not contain layout/theme.liquid, so Shopify cannot create a valid destination theme.");
      }

      // Theme JSON/settings often reference Shopify Files using values like
      // shopify://shop_images/hero.jpg or /cdn/shop/files/hero.jpg. Those files
      // are store content, not theme assets, so they are not inside the theme ZIP.
      // Upload them to the destination Files area before creating the theme so
      // those image/video references can resolve after the theme is installed.
      const themeFileRefs = extractThemeFileReferences(zipFiles);
      const themeMediaResult = await createFilesOnTargetFromThemeRefs(sourceUrl, targetShop, targetToken, themeFileRefs);
      if (themeMediaResult.total) {
        results.push({
          key: "content/files",
          status: themeMediaResult.uploaded >= themeMediaResult.total ? "success" : "warning",
          error: themeMediaResult.uploaded >= themeMediaResult.total
            ? null
            : `Theme media copied ${themeMediaResult.uploaded}/${themeMediaResult.total}: ${themeMediaResult.warnings.slice(0, 5).join("; ")}`,
        });
      }

      const { id: zipId, token: zipToken } = await saveThemeZip(zipFiles);
      const appBaseUrl = (process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
      const zipSrcUrl = `${appBaseUrl}/theme-zip/${zipId}?token=${zipToken}`;

      console.log(`[importzo] Creating destination theme from ZIP src. shop=${targetShop} assets=${zipFiles.length} src=${zipSrcUrl}`);

      const createRes = await shopifyFetch(`https://${targetShop}/admin/api/${THEME_API_VERSION}/themes.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
        body: JSON.stringify({ theme: { name: `${themeName} (Transferred)`, src: zipSrcUrl, role: "unpublished" } }),
      });

      if (!createRes.ok) {
        const rawBody = await createRes.text().catch(() => "");
        console.error("[importzo] Theme ZIP create failed — HTTP", createRes.status, "body:", rawBody);
        let errJson = {};
        try { errJson = JSON.parse(rawBody); } catch { /* non-fatal — raw body used as fallback */ }
        throw new Error(`Failed to create theme from ZIP (HTTP ${createRes.status}): ${errJson.errors ? JSON.stringify(errJson.errors) : rawBody.slice(0, 300) || "no response body"}`);
      }

      const newTheme = (await createRes.json()).theme;
      if (!newTheme?.id) throw new Error("Theme creation failed: API did not return a theme ID");

      const pollResult = await (async () => {
        const deadline = Date.now() + 180000; // theme ZIP extraction can take a few minutes
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 5000));
          const chk = await shopifyFetch(`https://${targetShop}/admin/api/${THEME_API_VERSION}/themes/${newTheme.id}.json`, {
            headers: { "X-Shopify-Access-Token": targetToken },
          });
          if (chk.status === 404) {
            throw new Error(`Theme (ID ${newTheme.id}) disappeared after creation — the destination store may have reached its theme limit or rejected the ZIP.`);
          }
          if (!chk.ok) {
            console.warn(`[importzo] theme ZIP poll returned HTTP ${chk.status}, retrying...`);
            continue;
          }
          const chkTheme = (await chk.json()).theme;
          if (chkTheme?.processing === false) return chkTheme;
          console.log(`[importzo] theme ${newTheme.id} still processing ZIP, waiting...`);
        }
        return null;
      })();

      if (!pollResult) {
        throw new Error(`Theme (ID ${newTheme.id}) is still processing after 180 seconds. Check destination store themes page; if it is incomplete, retry with a smaller theme.`);
      }

      // Keep the ZIP available long enough for any delayed Shopify fetches, then clean up.
      await deleteThemeZipLater(zipId, zipToken);

      // Phase 5: a whole theme transfer is one record — there's no
      // meaningful sub-unit to count (the assets that make it up aren't
      // separately addressable "records" the way products/pages are).
      await recordUsageAndCheck({ prisma, shop: targetShop, count: 1 });

      return {
        intent: "transfer-theme",
        rid,
        ok: true,
        themeName,
        themeId: newTheme.id,
        newThemeId: newTheme.id,
        newThemeName: newTheme.name,
        previewUrl: `https://${targetShop}/?preview_theme_id=${newTheme.id}`,
        assetCount: assetsList.length,
        results,
        destinationAdminUrl: `https://${targetShop.replace(/\.myshopify\.com$/i, "")}.myshopify.com/admin/themes`,
      };
    } catch (err) {
      return { intent: "transfer-theme", rid, ok: false, error: err.message };
    }
  }

  // ── Transfer store content & media ──
  if (intent === "transfer-content") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    const dryRun = formData.get("dryRun") === "true";
    try {
      return await transferContentAndMedia(sourceUrl, sourceToken, dryRun);
    } catch (err) {
      return { intent: "transfer-content", rid, ok: false, error: err.message, results: [{ type: "content", title: "Content transfer", status: "error", error: err.message }] };
    }
  }

  // ── Save transfer record to DB ──
  if (intent === "save-record") {
    try {
      const summary = JSON.parse(formData.get("summary") || "{}") || {};
      await prisma.importJob.create({
        data: {
          shop: session.shop,
          fileName: `store_transfer_${summary.source || "unknown"}`,
          totalRows: summary.totalItems || 0,
          successCount: summary.successItems || 0,
          errorCount: summary.errorItems || 0,
          status: (summary.errorItems || 0) === 0 ? "completed" : (summary.successItems || 0) === 0 ? "failed" : "completed_with_errors",
          results: formData.get("results") || "[]",
          importType: "transfer",
        },
      });
    } catch (err) {
      console.warn("[importzo] save transfer record failed:", err?.message || err);
    }
    // Clean up the TransferSession on transfer completion (security: no lingering tokens)
    const completedSessionId = (formData.get("sessionId") || "").trim();
    if (completedSessionId) {
      try {
        await prisma.transferSession.deleteMany({ where: { id: completedSessionId } });
      } catch (_) { /* non-fatal — table may not exist on older deployments */ }
    }
    return { intent: "save-record", rid, ok: true };
  }

  return { intent, rid, ok: false, error: "Unknown action" };
};

// ═══════════════════════════════════════════════════════════════════
// Client
// ═══════════════════════════════════════════════════════════════════
const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";

const STEP_CONNECT = 0;
const STEP_SCOPE = 1;
const STEP_CONFIGURE = 2;
const STEP_PREVIEW = 3;
const STEP_TRANSFER = 4;
const STEP_RESULTS = 5;

const STEP_LABELS = ["Connect", "Scope", "Configure", "Preview", "Transfer", "Results"];

const MODULES = [
  { key: "collections", label: "Collections & Products", desc: "Custom and smart collections with all linked products", icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z", available: true },
  { key: "products", label: "Standalone Products", desc: "Products not in any collection", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10l8 4", available: true },
  { key: "content", label: "Content & Media", desc: "Pages, blogs, articles, store files, policies-as-pages, navigation menus and metafields", icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5A3.375 3.375 0 0010.125 2.25H8.25m0 12.75h7.5m-7.5 3h7.5M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z", available: true },
  { key: "themes", label: "Themes", desc: "Copies theme files as an unpublished theme on the destination", icon: "M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42", available: true },
];

// Present the current store as a destination label — strip the myshopify
// suffix so merchants see their store name at a glance.
function formatShopName(shop) {
  if (!shop) return "current store";
  return shop.replace(/\.myshopify\.com$/i, "");
}

const AVAILABLE_KEYS = MODULES.filter((m) => m.available).map((m) => m.key);

let _rid = 0;
function nextRid() { return String(++_rid); }

export default function StoreTransferPage() {
  const { savedConnection, currentShop } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const saveFetcher = useFetcher();
  const sessionFetcher = useFetcher();

  const destinationName = formatShopName(currentShop);

  const [step, setStep] = useState(STEP_CONNECT);
  const [, setSourceUrl] = useState("");
  const [, setSourceToken] = useState("");
  const [sourceInfo, setSourceInfo] = useState(null);
  const [hasSavedConnection, setHasSavedConnection] = useState(!!savedConnection);

  // Session pairing state
  const [sessionTab, setSessionTab] = useState("dest"); // default — restored to "source" if session found in storage
  const [sessionPassword, setSessionPassword] = useState("");
  const [sessionConfirmPassword, setSessionConfirmPassword] = useState("");
  const [sessionCodeInput, setSessionCodeInput] = useState(""); // dest: code entered by user
  const [sessionCode, setSessionCode] = useState(""); // source: generated code
  const [, setSessionId] = useState(null);
  const [sessionStorageAvailable, setSessionStorageAvailable] = useState(true);
  const [sessionExpiresAt, setSessionExpiresAt] = useState(null);
  const [sessionCountdown, setSessionCountdown] = useState(null);
  const [sessionError, setSessionError] = useState("");


  // Scope
  const [scope, setScope] = useState("full"); // "full" | "custom"
  const [selectedModules, setSelectedModules] = useState(new Set(AVAILABLE_KEYS));

  // Configure — seeded from user prefs after mount (SSR-safe)
  const [dryRun, setDryRun] = useState(false);
  const [conflictMode, setConflictMode] = useState("skip");
  const [selectedThemeId, setSelectedThemeId] = useState(null);
  const [ownershipConsent, setOwnershipConsent] = useState(false);
  // Phase 4.2: optional Markets-scoped product transfer.
  const [selectedMarketId, setSelectedMarketId] = useState("");

  useEffect(() => {
    const prefs = loadPrefs();
    setDryRun(!!prefs.dryRunByDefault);
    setConflictMode(prefs.duplicateHandling || "skip");
  }, []);

  // Transfer state
  const [transferResults, setTransferResults] = useState({});
  const [currentModule, setCurrentModule] = useState(null);
  const [moduleProgress, setModuleProgress] = useState({ idx: 0, total: 0, name: "" });
  const [error, setError] = useState("");
  const [loadingMsg, setLoadingMsg] = useState("");
  const [transferElapsed, setTransferElapsed] = useState(0);

  // Refs
  const credsRef = useRef({ url: "", token: "" });
  const processedRids = useRef(new Set());
  const moduleQueueRef = useRef([]);
  const collectionQueueRef = useRef([]);
  const collectionsDataRef = useRef([]);
  const transferResultsRef = useRef({});
  const savingRecord = useRef(false);
  // Bug fix: tracks completion so safety timeout doesn't fire after transfer done
  const transferDoneRef = useRef(false);
  // Session ID ref: keeps sessionId accessible in callbacks/effects without stale closures
  const sessionIdRef = useRef(null);
  // Async product-job polling refs
  const pollIntervalRef = useRef(null);
  const migrationJobIdRef = useRef(null);

  // Restore session code from sessionStorage on mount (survives page reloads within the tab).
  // sessionStorage is cleared automatically when the browser tab is closed.
  useEffect(() => {
    // Detect availability first — fails in incognito or strict iframe contexts
    let storageOk = true;
    try {
      sessionStorage.setItem("__importzo_chk__", "1");
      sessionStorage.removeItem("__importzo_chk__");
    } catch {
      storageOk = false;
    }
    setSessionStorageAvailable(storageOk);

    if (!storageOk) return;

    try {
      const stored = sessionStorage.getItem("importzo_session");
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed?.code || !parsed?.sessionId || !parsed?.expiresAt) return;
      if (new Date(parsed.expiresAt) <= new Date()) {
        sessionStorage.removeItem("importzo_session");
        return;
      }
      setSessionCode(parsed.code);
      setSessionId(parsed.sessionId);
      sessionIdRef.current = parsed.sessionId;
      setSessionExpiresAt(parsed.expiresAt);
      setSessionTab("source");
    } catch { /* sessionStorage unavailable — non-fatal */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isBusy = fetcher.state !== "idle";

  // ── Process connect/verify response ──
  function handleConnectResponse(d) {
    setLoadingMsg("");
    if (d.ok) {
      setSourceInfo({
        shopName: d.shopName, shopEmail: d.shopEmail, shopPlan: d.shopPlan,
        shopDomain: d.shopDomain || d.sourceShop || "",
        productCount: d.productCount, collectionCount: d.collectionCount,
        themeCount: d.themeCount, themes: d.themes || [],
        markets: d.markets || [],
      });
      credsRef.current.url = d.shopDomain;
      setHasSavedConnection(true);
      setError("");
      if (d.themes?.length > 0) {
        const main = d.themes.find((t) => t.role === "main") || d.themes[0];
        setSelectedThemeId(main.id);
      }
      setStep(STEP_SCOPE);
      shopify.toast.show(`Connected to ${d.shopName}`);
    } else {
      setError(d.error || "Connection failed");
      if (d.intent === "verify-connection") setHasSavedConnection(false);
    }
  }

  // ── Advance to next module in transfer queue ──
  function advanceModuleQueue() {
    if (moduleQueueRef.current.length > 0) {
      const next = moduleQueueRef.current.shift();
      startModuleTransfer(next);
    } else {
      transferDoneRef.current = true; // mark done before setStep so safety timeout won't fire
      setCurrentModule(null);
      setStep(STEP_RESULTS);
      shopify.toast.show("Transfer complete!");
      notifyJobComplete("Importzo — Transfer Complete", `Store transfer from ${sourceInfo?.shopName || "source"} finished.`);
      saveRecord();
    }
  }

  function startModuleTransfer(moduleKey) {
    setCurrentModule(moduleKey);

    if (moduleKey === "collections") {
      setLoadingMsg("Fetching collections...");
      const fd = new FormData();
      fd.append("intent", "fetch-collections");
      fd.append("rid", nextRid());
      if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
      fetcher.submit(fd, { method: "POST" });
    } else if (moduleKey === "products") {
      if (dryRun) {
        // Dry run: quick synchronous count — keep existing path
        setLoadingMsg("Counting standalone products (dry run)...");
        const fd = new FormData();
        fd.append("intent", "transfer-products");
        fd.append("skipCollectionProducts", selectedModules.has("collections") ? "true" : "false");
        fd.append("dryRun", "true");
        fd.append("conflictMode", conflictMode);
        fd.append("altTextAutoGenerate", String(loadPrefs().altTextAutoGenerate));
        fd.append("rid", nextRid());
        if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
        fetcher.submit(fd, { method: "POST" });
      } else {
        // Real transfer: create background job and poll — no HTTP timeout risk
        setLoadingMsg("Starting product transfer...");
        const fd = new FormData();
        fd.append("conflictMode", conflictMode);
        fd.append("altTextAutoGenerate", String(loadPrefs().altTextAutoGenerate));
        if (selectedMarketId) fd.append("marketId", selectedMarketId);
        if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
        fetch("/api/migration-job", { method: "POST", body: fd, credentials: "same-origin" })
          .then((r) => r.json())
          .then((data) => {
            if (!data.ok) {
              setError(data.error || "Failed to start product transfer job");
              transferDoneRef.current = true;
              setCurrentModule(null);
              setStep(STEP_RESULTS);
              saveRecord();
              return;
            }
            migrationJobIdRef.current = data.jobId;
            setLoadingMsg("Transferring products in background — this may take several minutes for large stores...");
          })
          .catch((err) => {
            setError(`Failed to start product transfer: ${err.message}`);
            transferDoneRef.current = true;
            setCurrentModule(null);
            setStep(STEP_RESULTS);
            saveRecord();
          });
      }
    } else if (moduleKey === "content") {
      setLoadingMsg("Transferring pages, blogs, files and menus...");
      const fd = new FormData();
      fd.append("intent", "transfer-content");
      fd.append("dryRun", String(dryRun));
      fd.append("rid", nextRid());
      if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
      fetcher.submit(fd, { method: "POST" });
    } else if (moduleKey === "themes") {
      if (!selectedThemeId) { advanceModuleQueue(); return; }
      const theme = sourceInfo?.themes?.find((t) => t.id === selectedThemeId);
      setLoadingMsg(`Copying "${theme?.name || "theme"}" files to destination — large themes may take 1–2 min...`);
      const fd = new FormData();
      fd.append("intent", "transfer-theme");
      fd.append("themeId", String(selectedThemeId));
      fd.append("themeName", theme?.name || "Theme");
      fd.append("dryRun", String(dryRun));
      fd.append("rid", nextRid());
      if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
      fetcher.submit(fd, { method: "POST" });
    }
  }

  // ── Cycling loading messages during theme transfer ──
  // Theme transfer is a single server round-trip so per-asset progress is
  // unavailable on the client. Cycle descriptive messages every 15s to
  // reassure the user that work is still happening.
  useEffect(() => {
    if (currentModule !== "themes") return;
    const MESSAGES = [
      "Copying theme files to destination...",
      "Transferring CSS, JS and Liquid templates...",
      "Uploading images and binary assets (this takes longer)...",
      "Almost done — finalizing theme...",
      "Large theme detected — still working, please wait...",
    ];
    let idx = 0;
    setLoadingMsg(MESSAGES[0]);
    const iv = setInterval(() => {
      idx = Math.min(idx + 1, MESSAGES.length - 1);
      setLoadingMsg(MESSAGES[idx]);
    }, 15000);
    return () => clearInterval(iv);
  }, [currentModule]);

  // ── Background product-job polling ──
  // Polls /api/migration-status/:jobId every 4 seconds while currentModule === "products"
  // and migrationJobIdRef.current is set. Advances the queue on COMPLETED/FAILED.
  useEffect(() => {
    if (currentModule !== "products" || dryRun) return;

    const POLL_MS = 4000;
    const id = setInterval(async () => {
      const jobId = migrationJobIdRef.current;
      if (!jobId) return; // job not started yet — wait
      try {
        const res = await fetch(`/api/migration-status/${jobId}`, { credentials: "same-origin" });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.ok) return;

        const { status, processedProducts, totalProducts, failedProducts, pct, errorLog } = data;

        // Update loading message with live progress
        if (totalProducts > 0) {
          setLoadingMsg(
            `Transferring products: ${processedProducts.toLocaleString()} / ${totalProducts.toLocaleString()} (${pct}%)${failedProducts > 0 ? ` — ${failedProducts} failed` : ""}`,
          );
        }

        if (status === "COMPLETED" || status === "FAILED") {
          clearInterval(id);
          migrationJobIdRef.current = null;

          const succeeded = (processedProducts || 0) - (failedProducts || 0);
          const syntheticResults = {
            ok: status === "COMPLETED",
            intent: "transfer-products",
            total: totalProducts || 0,
            transferred: processedProducts || 0,
            results: [
              ...(succeeded > 0 ? [{ title: `${succeeded} products`, status: "success" }] : []),
              ...(failedProducts > 0 ? [{ title: `${failedProducts} products failed`, status: "error", error: (errorLog || []).slice(-3).map((e) => e.error).join("; ") }] : []),
            ],
            async: true,
            jobId,
          };
          if (status === "FAILED" && !processedProducts) {
            const lastErr = errorLog?.[errorLog.length - 1]?.error || "Unknown error";
            syntheticResults.error = lastErr;
          }

          const updated = { ...transferResultsRef.current, products: syntheticResults };
          transferResultsRef.current = updated;
          setTransferResults(updated);
          setLoadingMsg("");
          advanceModuleQueue();
        }
      } catch (err) {
        console.warn("[transfer] polling error:", err.message);
      }
    }, POLL_MS);

    pollIntervalRef.current = id;
    return () => {
      clearInterval(id);
      pollIntervalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentModule, dryRun]);

  // ── Main fetcher response handler ──
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const d = fetcher.data;
    if (!d.rid || processedRids.current.has(d.rid)) return;
    processedRids.current.add(d.rid);

    if (d.intent === "connect" || d.intent === "verify-connection") {
      handleConnectResponse(d);
      return;
    }

    if (d.intent === "disconnect") {
      setHasSavedConnection(false);
      setSourceInfo(null);
      setStep(STEP_CONNECT);
      setError("");
      shopify.toast.show("Disconnected");
      return;
    }

    if (d.intent === "fetch-collections") {
      setLoadingMsg("");
      if (!d.ok) {
        setError(d.error || "Failed to fetch collections from source store");
        transferDoneRef.current = true;
        setCurrentModule(null);
        setStep(STEP_RESULTS);
        saveRecord();
        return;
      }
      collectionsDataRef.current = d.collections;
      if (d.collections.length === 0) {
        const updated = { ...transferResultsRef.current, collections: { items: [], error: null } };
        transferResultsRef.current = updated;
        setTransferResults(updated);
        advanceModuleQueue();
        return;
      }
      // Start transferring collections one by one
      collectionQueueRef.current = d.collections.slice(1);
      setModuleProgress({ idx: 1, total: d.collections.length, name: d.collections[0].title });
      const fd = new FormData();
      fd.append("intent", "transfer");
      fd.append("collection", JSON.stringify(d.collections[0]));
      fd.append("dryRun", String(dryRun));
      fd.append("conflictMode", conflictMode);
      fd.append("altTextAutoGenerate", String(loadPrefs().altTextAutoGenerate));
      fd.append("rid", nextRid());
      if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
      fetcher.submit(fd, { method: "POST" });
      return;
    }

    if (d.intent === "transfer" && d.result) {
      // Collection transfer result
      const prev = transferResultsRef.current.collections || { items: [], error: null };
      const updated = { ...transferResultsRef.current, collections: { items: [...prev.items, d.result], error: null } };
      transferResultsRef.current = updated;
      setTransferResults(updated);

      if (collectionQueueRef.current.length > 0) {
        const next = collectionQueueRef.current.shift();
        const total = collectionsDataRef.current.length;
        const idx = total - collectionQueueRef.current.length;
        setModuleProgress({ idx, total, name: next.title });
        const fd = new FormData();
        fd.append("intent", "transfer");
        fd.append("collection", JSON.stringify(next));
        fd.append("dryRun", String(dryRun));
        fd.append("conflictMode", conflictMode);
        fd.append("altTextAutoGenerate", String(loadPrefs().altTextAutoGenerate));
        fd.append("rid", nextRid());
        if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
        fetcher.submit(fd, { method: "POST" });
      } else {
        advanceModuleQueue();
      }
      return;
    }

    if (d.intent === "transfer-products") {
      setLoadingMsg("");
      const updated = { ...transferResultsRef.current, products: d };
      transferResultsRef.current = updated;
      setTransferResults(updated);
      advanceModuleQueue();
      return;
    }

    if (d.intent === "transfer-content") {
      setLoadingMsg("");
      const updated = { ...transferResultsRef.current, content: d };
      transferResultsRef.current = updated;
      setTransferResults(updated);
      if (!d.ok && d.error) setError(d.error);
      advanceModuleQueue();
      return;
    }

    if (d.intent === "transfer-theme") {
      setLoadingMsg("");
      const updated = { ...transferResultsRef.current, themes: d };
      transferResultsRef.current = updated;
      setTransferResults(updated);
      if (!d.ok && d.error) {
        // Fatal theme error (e.g. 401, theme create failed) — surface prominently
        setError(d.error);
      } else if (d.ok && d.previewUrl) {
        shopify.toast.show(`Theme "${d.newThemeName || d.themeName}" created as unpublished`);
      }
      advanceModuleQueue();
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // ── Elapsed timer while transferring ──
  useEffect(() => {
    if (step !== STEP_TRANSFER) { setTransferElapsed(0); return; }
    const id = setInterval(() => setTransferElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [step]);

  // Safety: if fetcher stalls for >180s during transfer, surface an error
  // Bug fix: was checking stale `step` closure (always STEP_TRANSFER) — now uses ref so it
  // won't fire after transfer already completed via advanceModuleQueue
  useEffect(() => {
    if (step !== STEP_TRANSFER) return;
    const safetyId = setTimeout(() => {
      if (!transferDoneRef.current) {
        transferDoneRef.current = true;
        setError("Transfer timed out after 10 minutes without a server response. This usually means the theme is very large, the destination theme never became writable, or the connection was interrupted. Any modules that already completed are shown below — you can retry the remaining ones separately.");
        setCurrentModule(null);
        setStep(STEP_RESULTS);
        saveRecord();
      }
    }, 600000);
    return () => clearTimeout(safetyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, fetcher.state]);

  // ── Save record ──
  function saveRecord() {
    if (savingRecord.current) return;
    savingRecord.current = true;
    const r = transferResultsRef.current;
    let totalItems = 0, successItems = 0, errorItems = 0;

    if (r.collections?.items) {
      for (const col of r.collections.items) {
        totalItems += col.products.length;
        successItems += col.products.filter((p) => p.status === "success").length;
        errorItems += col.products.filter((p) => p.status === "error").length;
      }
    }
    if (r.products?.results) {
      totalItems += r.products.results.length;
      successItems += r.products.results.filter((p) => p.status === "success").length;
      errorItems += r.products.results.filter((p) => p.status === "error").length;
    }
    if (r.themes?.results) {
      totalItems += r.themes.results.length;
      successItems += r.themes.results.filter((a) => a.status === "success").length;
      errorItems += r.themes.results.filter((a) => a.status === "error").length;
    }

    const fd = new FormData();
    fd.append("intent", "save-record");
    fd.append("summary", JSON.stringify({ source: sourceInfo?.shopName || "unknown", totalItems, successItems, errorItems }));
    fd.append("results", JSON.stringify(r));
    fd.append("rid", nextRid());
    if (sessionIdRef.current) fd.append("sessionId", sessionIdRef.current);
    saveFetcher.submit(fd, { method: "POST" });
  }

  // ── Actions ──
  const handleReconnect = useCallback(() => {
    setError(""); setLoadingMsg("Verifying saved connection...");
    const fd = new FormData();
    fd.append("intent", "verify-connection");
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher]);

  const handleDisconnect = useCallback(() => {
    // Cancel any active transfer session first (security: revoke paired session)
    if (sessionIdRef.current) {
      const sfd = new FormData();
      sfd.append("intent", "cancel-session");
      sfd.append("sessionId", sessionIdRef.current);
      sessionFetcher.submit(sfd, { method: "POST", action: "/app/transfer-session" });
      sessionIdRef.current = null;
      setSessionId(null);
    }
    const fd = new FormData();
    fd.append("intent", "disconnect");
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher, sessionFetcher]);

  const handleChangeStore = useCallback(() => {
    setHasSavedConnection(false);
    setSourceInfo(null);
    setSourceUrl("");
    setSourceToken("");
    credsRef.current = { url: "", token: "" };
  }, []);

  // ── Session pairing handlers ──────────────────────────────────────────────

  const handleCreateSession = useCallback(() => {
    if (sessionPassword !== sessionConfirmPassword) {
      setSessionError("Passwords do not match");
      return;
    }
    if (sessionPassword.length < 4) {
      setSessionError("Password must be at least 4 characters");
      return;
    }
    setSessionError("");
    const fd = new FormData();
    fd.append("intent", "create-session");
    fd.append("password", sessionPassword);
    sessionFetcher.submit(fd, { method: "POST", action: "/app/transfer-session" });
  }, [sessionFetcher, sessionPassword, sessionConfirmPassword]);

  const handleJoinSession = useCallback(() => {
    if (!sessionCodeInput.trim() || !sessionPassword) {
      setSessionError("Please enter both the session code and password");
      return;
    }
    setSessionError("");
    const fd = new FormData();
    fd.append("intent", "join-session");
    fd.append("code", sessionCodeInput.trim().toUpperCase());
    fd.append("password", sessionPassword);
    sessionFetcher.submit(fd, { method: "POST", action: "/app/transfer-session" });
  }, [sessionFetcher, sessionCodeInput, sessionPassword]);

  const handleCancelSession = useCallback(() => {
    if (sessionIdRef.current) {
      const fd = new FormData();
      fd.append("intent", "cancel-session");
      fd.append("sessionId", sessionIdRef.current);
      sessionFetcher.submit(fd, { method: "POST", action: "/app/transfer-session" });
    }
    setSessionCode("");
    setSessionId(null);
    sessionIdRef.current = null;
    setSessionExpiresAt(null);
    setSessionPassword("");
    setSessionConfirmPassword("");
    setSessionError("");
    try { sessionStorage.removeItem("importzo_session"); } catch { /* non-fatal */ }
  }, [sessionFetcher]);

  // Countdown timer for source store session code
  useEffect(() => {
    if (!sessionExpiresAt) { setSessionCountdown(null); return; }
    const update = () => {
      const secs = Math.max(0, Math.round((new Date(sessionExpiresAt) - Date.now()) / 1000));
      setSessionCountdown(secs);
      if (secs === 0) {
        setSessionCode("");
        setSessionExpiresAt(null);
        setSessionId(null);
        sessionIdRef.current = null;
        try { sessionStorage.removeItem("importzo_session"); } catch { /* non-fatal */ }
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [sessionExpiresAt]);

  // Session fetcher response handler
  useEffect(() => {
    if (sessionFetcher.state !== "idle" || !sessionFetcher.data) return;
    const d = sessionFetcher.data;

    if (d.intent === "create-session") {
      if (d.ok) {
        setSessionCode(d.code);
        setSessionId(d.sessionId);
        sessionIdRef.current = d.sessionId;
        setSessionExpiresAt(d.expiresAt);
        setSessionError("");
        // Persist to sessionStorage so the code survives page reloads
        try {
          sessionStorage.setItem("importzo_session", JSON.stringify({
            code: d.code, sessionId: d.sessionId, expiresAt: d.expiresAt,
          }));
        } catch { /* sessionStorage unavailable — non-fatal */ }
      } else {
        setSessionError(d.error || "Failed to create session");
      }
      return;
    }

    if (d.intent === "join-session") {
      if (d.ok) {
        setSessionId(d.sessionId);
        sessionIdRef.current = d.sessionId;
        setSessionError("");
        // Reuse existing connect-response handler — populates sourceInfo and advances to STEP_SCOPE
        handleConnectResponse({ ...d, intent: "connect" });
      } else {
        setSessionError(d.error || "Failed to connect to source store");
      }
      return;
    }
    // cancel-session: client state already cleared before submitting — no-op here
  }, [sessionFetcher.state, sessionFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const startTransfer = useCallback(() => {
    const modules = [...selectedModules].filter((k) => MODULES.find((m) => m.key === k)?.available);
    if (modules.length === 0) return;

    setStep(STEP_TRANSFER);
    setTransferResults({});
    transferResultsRef.current = {};
    setError("");
    savingRecord.current = false;
    transferDoneRef.current = false;
    collectionsDataRef.current = [];
    collectionQueueRef.current = [];
    migrationJobIdRef.current = null;
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }

    // Build module queue
    moduleQueueRef.current = modules.slice(1);
    startModuleTransfer(modules[0]);
  }, [selectedModules, dryRun, selectedThemeId, conflictMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetAll = useCallback(() => {
    setStep(STEP_CONNECT);
    setSourceInfo(null);
    setScope("full");
    setSelectedModules(new Set(AVAILABLE_KEYS));
    setDryRun(false);
    setConflictMode("skip");
    setTransferResults({});
    transferResultsRef.current = {};
    setCurrentModule(null);
    setError("");
    setLoadingMsg("");
    savingRecord.current = false;
    migrationJobIdRef.current = null;
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    // Reset session state
    setSessionCode("");
    setSessionId(null);
    sessionIdRef.current = null;
    setSessionExpiresAt(null);
    setSessionPassword("");
    setSessionConfirmPassword("");
    setSessionCodeInput("");
    setSessionError("");
  }, []);

  const toggleModule = useCallback((key) => {
    setSelectedModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // ── Computed ──
  const activeModules = [...selectedModules].filter((k) => MODULES.find((m) => m.key === k)?.available);

  function getModuleStats(key) {
    const r = transferResults;
    if (key === "collections" && r.collections?.items) {
      const products = r.collections.items.flatMap((c) => c.products);
      return { total: products.length, success: products.filter((p) => p.status === "success").length, errors: products.filter((p) => p.status === "error").length, dryRun: products.filter((p) => p.status === "dry-run").length };
    }
    if (key === "products" && r.products?.results) {
      return { total: r.products.results.length, success: r.products.results.filter((p) => p.status === "success").length, errors: r.products.results.filter((p) => p.status === "error").length, dryRun: r.products.results.filter((p) => p.status === "dry-run").length };
    }
    if (key === "content" && r.content?.results) {
      const flat = r.content.results.flatMap((x) => x.type === "blog" ? [x, ...(x.articleResults || [])] : [x, ...(x.results || [])]);
      return {
        total: flat.length,
        success: flat.filter((x) => x.status === "success" || x.status === "warning").length,
        errors: flat.filter((x) => x.status === "error").length,
        dryRun: flat.filter((x) => x.status === "dry-run").length,
      };
    }
    if (key === "themes") {
      if (r.themes?.results) {
        return { total: r.themes.results.length, success: r.themes.results.filter((a) => a.status === "success").length, errors: r.themes.results.filter((a) => a.status === "error").length, dryRun: r.themes.results.filter((a) => a.status === "dry-run").length };
      }
      if (r.themes) {
        // Transfer ran but returned no results (server error or timeout)
        return { total: 0, success: 0, errors: 1, dryRun: 0 };
      }
    }
    return null;
  }

  // Error report download — CSV-safe with proper escaping
  function downloadErrors(moduleKey) {
    const stats = getModuleStats(moduleKey);
    if (!stats) return;
    function esc(v) { const s = String(v || ""); return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g, '""')}"` : s; }
    const rows = ["Module,Type,Item,Error,Friendly Explanation"];
    const r = transferResults;
    if (moduleKey === "collections" && r.collections?.items) {
      for (const col of r.collections.items) {
        if (col.collectionError) rows.push([esc(moduleKey), "collection", esc(col.collectionTitle), esc(col.collectionError), esc(friendlyError(col.collectionError))].join(","));
        for (const p of col.products.filter((x) => x.status === "error")) {
          rows.push([esc(moduleKey), "product", esc(`${col.collectionTitle} > ${p.title}`), esc(p.error), esc(friendlyError(p.error))].join(","));
        }
      }
    }
    if (moduleKey === "products" && r.products?.results) {
      for (const p of r.products.results.filter((x) => x.status === "error")) {
        rows.push([esc(moduleKey), "product", esc(p.title), esc(p.error), esc(friendlyError(p.error))].join(","));
      }
    }
    if (moduleKey === "content" && r.content?.results) {
      const flat = r.content.results.flatMap((x) => x.type === "blog" ? [x, ...(x.articleResults || [])] : [x, ...(x.results || [])]);
      for (const item of flat.filter((x) => x.status === "error" || (x.warnings && x.warnings.length))) {
        const err = item.error || (item.warnings || []).join("; ");
        rows.push([esc(moduleKey), esc(item.type || "content"), esc(item.title || "item"), esc(err), esc(friendlyError(err))].join(","));
      }
    }
    if (moduleKey === "themes") {
      if (r.themes?.results) {
        for (const a of r.themes.results.filter((x) => x.status === "error")) {
          rows.push([esc(moduleKey), "asset", esc(a.key), esc(a.error), esc(friendlyError(a.error))].join(","));
        }
      } else if (r.themes?.error) {
        rows.push([esc(moduleKey), "theme", "transfer", esc(r.themes.error), esc(friendlyError(r.themes.error))].join(","));
      }
    }
    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `transfer_errors_${moduleKey}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════
  return (
    <s-page heading="Transfer Store" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }} className="flex items-center gap-1.5">
            Transfer Store <LeafIcon size={14} />
          </span>
        </div>

        {/* ── Direction banner — makes source/destination unambiguous ── */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100" style={{ background: "linear-gradient(90deg, rgba(23,50,10,0.04), rgba(46,99,22,0.02))" }}>
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>How store transfer works</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Data from the connected <strong>source store</strong> will be copied <strong>into this current store</strong>. The current store is always the destination.
            </p>
          </div>
          <div className="px-5 py-4 flex items-center gap-3 flex-wrap">
            {/* Source pill */}
            <div className="flex-1 min-w-[180px] rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Source Store</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5 truncate">
                {sourceInfo?.shopName || (savedConnection?.sourceName) || "Not connected yet"}
              </p>
              <p className="text-[11px] text-gray-500 truncate">
                {sourceInfo?.shopDomain || savedConnection?.sourceUrl || "Connect below to choose the store to copy from"}
              </p>
            </div>

            {/* Arrow */}
            <div className="flex items-center justify-center text-gray-400">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </div>

            {/* Destination pill (current store) */}
            <div className="flex-1 min-w-[180px] rounded-lg border-2 px-4 py-3" style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: S }}>Destination Store (Current)</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5 truncate">{destinationName}</p>
              <p className="text-[11px] text-gray-500 truncate">{currentShop || ""}</p>
            </div>
          </div>
        </div>

        {/* ── Legal disclaimer ── */}
        <p className="text-xs text-gray-500 px-1">
          <svg className="inline w-3.5 h-3.5 mr-1 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ verticalAlign: "-2px" }}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
          Only transfer store data you own or have rights to.
        </p>

        {/* Stepper */}
        {step >= STEP_CONNECT && (
          <div className="px-1 pb-2">
            <div className="flex items-center justify-between max-w-3xl mx-auto">
              {STEP_LABELS.map((label, i) => (
                <div key={label} className="flex items-center flex-1 last:flex-initial">
                  <div className="flex flex-col items-center gap-1.5">
                    <div style={{
                      width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 600,
                      ...(i <= step ? { background: P, color: "#fff", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" } : { background: "#E5E7EB", color: "#6b7280" }),
                    }}>
                      {i < step ? <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> : i + 1}
                    </div>
                    <span className={`text-[10px] font-medium hidden sm:block ${i <= step ? "text-gray-900" : "text-gray-400"}`}>{label}</span>
                  </div>
                  {i < 5 && <div style={{ flex: 1, height: 2, marginLeft: 8, marginRight: 8, borderRadius: 1, background: i < step ? P : "#e5e7eb" }} />}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error — replaced raw red div with shared ErrorBanner (critical) */}
        {error && <ErrorBanner title="Something went wrong" message={error} onDismiss={() => setError("")} />}

        {/* ═══ STEP 0: CONNECT ═══ */}
        {step === STEP_CONNECT && (
          <div className="animate-fade-in space-y-5">
            {/* Saved connection card */}
            {hasSavedConnection && savedConnection && (
              <div className="bg-white rounded-xl border-2 border-green-200 p-6 shadow-sm max-w-xl mx-auto">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900">Previously connected source store</p>
                    <p className="text-base font-bold text-gray-900">{savedConnection.sourceName}</p>
                    <p className="text-xs text-gray-500">{savedConnection.sourceUrl}{savedConnection.sourcePlan ? ` · ${savedConnection.sourcePlan}` : ""}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">Data will be copied from this store into <strong>{destinationName}</strong> (current store).</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={handleReconnect} disabled={isBusy}
                    style={!isBusy ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                    className={`px-5 py-2.5 text-sm rounded-lg transition-all ${!isBusy ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                  >
                    {isBusy ? (
                      <span className="flex items-center gap-2">
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                        {loadingMsg || "Reconnecting..."}
                      </span>
                    ) : "Reconnect & Continue"}
                  </button>
                  <button onClick={handleChangeStore} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Change Store</button>
                  <button onClick={handleDisconnect} disabled={isBusy} className="px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50">Disconnect</button>
                </div>
              </div>
            )}

            {/* New connection — Transfer Session pairing */}
            {(!hasSavedConnection || !savedConnection) && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden max-w-xl mx-auto">
                {/* How it works banner */}
                <div className="px-6 pt-5 pb-4 border-b border-gray-100" style={{ background: "rgba(23,50,10,0.03)" }}>
                  <p className="text-sm font-semibold text-gray-900 mb-1">How store pairing works</p>
                  <p className="text-xs text-gray-500">
                    Both stores install Importzo. The <strong>source store</strong> generates a one-time session code.
                    The <strong>destination store</strong> enters that code to pair — no API tokens needed.
                  </p>
                </div>

                {/* Tab switcher */}
                <div className="px-6 pt-5">
                  <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-gray-100 mb-6">
                    {[
                      { val: "dest", label: "I'm the Destination Store", sub: "Receiving data" },
                      { val: "source", label: "I'm the Source Store", sub: "Exporting data" },
                    ].map((t) => (
                      <button key={t.val} onClick={() => { setSessionTab(t.val); setSessionError(""); }}
                        className={`px-3 py-2.5 rounded-lg text-left transition-all text-sm ${sessionTab === t.val ? "bg-white shadow-sm font-semibold text-gray-900" : "text-gray-500 hover:text-gray-700"}`}
                      >
                        {t.label}
                        <span className="block text-[10px] font-normal mt-0.5 opacity-70">{t.sub}</span>
                      </button>
                    ))}
                  </div>

                  {/* Session error */}
                  {sessionError && (
                    <div className="mb-4 rounded-lg px-4 py-3 bg-red-50 border border-red-200 flex items-start gap-2">
                      <svg className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                      <p className="text-xs text-red-700">{sessionError}</p>
                    </div>
                  )}

                  {/* ── TAB: DESTINATION STORE ── */}
                  {sessionTab === "dest" && (
                    <div className="pb-6 space-y-4">
                      <div>
                        <label htmlFor="dest-session-code" className="block text-sm font-medium text-gray-700 mb-1.5">Session Code</label>
                        <input
                          id="dest-session-code"
                          type="text"
                          value={sessionCodeInput}
                          onChange={(e) => setSessionCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                          onKeyDown={(e) => e.key === "Enter" && handleJoinSession()}
                          placeholder="X7K2P9"
                          maxLength={6}
                          className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent font-mono tracking-widest text-center text-lg uppercase"
                          disabled={sessionFetcher.state !== "idle"}
                        />
                        <p className="text-[11px] text-gray-400 mt-1">6-character code shared by the source store owner</p>
                      </div>
                      <div>
                        <label htmlFor="dest-transfer-password" className="block text-sm font-medium text-gray-700 mb-1.5">Transfer Password</label>
                        <input
                          id="dest-transfer-password"
                          type="password"
                          value={sessionPassword}
                          onChange={(e) => setSessionPassword(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleJoinSession()}
                          placeholder="Password set by the source store"
                          className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent"
                          disabled={sessionFetcher.state !== "idle"}
                        />
                      </div>
                      <button
                        onClick={handleJoinSession}
                        disabled={sessionFetcher.state !== "idle" || !sessionCodeInput.trim() || !sessionPassword}
                        style={sessionFetcher.state === "idle" && sessionCodeInput.trim() && sessionPassword ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                        className={`w-full px-5 py-3 text-sm rounded-lg transition-all ${sessionFetcher.state === "idle" && sessionCodeInput.trim() && sessionPassword ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                      >
                        {sessionFetcher.state !== "idle" ? (
                          <span className="flex items-center justify-center gap-2">
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                            Connecting to Source Store...
                          </span>
                        ) : "Connect to Source Store"}
                      </button>
                      <div className="rounded-lg px-4 py-3 flex items-start gap-2.5" style={{ background: "rgba(23,50,10,0.04)", border: "1px solid rgba(23,50,10,0.08)" }}>
                        <svg className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: S }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>
                        <p className="text-[11px] text-gray-500">Tokens are matched server-side — they never appear in your browser. Session codes expire after 30 minutes.</p>
                      </div>
                    </div>
                  )}

                  {/* ── TAB: SOURCE STORE ── */}
                  {sessionTab === "source" && (
                    <div className="pb-6">
                      {!sessionCode ? (
                        // Pre-generation: set password
                        <div className="space-y-4">
                          <p className="text-xs text-gray-500">
                            Generate a one-time session code and share it with the destination store owner along with the password you set below.
                          </p>
                          <div>
                            <label htmlFor="src-transfer-password" className="block text-sm font-medium text-gray-700 mb-1.5">Transfer Password</label>
                            <input
                              id="src-transfer-password"
                              type="password"
                              value={sessionPassword}
                              onChange={(e) => setSessionPassword(e.target.value)}
                              placeholder="Set a transfer password"
                              className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent"
                              disabled={sessionFetcher.state !== "idle"}
                            />
                          </div>
                          <div>
                            <label htmlFor="src-confirm-password" className="block text-sm font-medium text-gray-700 mb-1.5">Confirm Password</label>
                            <input
                              id="src-confirm-password"
                              type="password"
                              value={sessionConfirmPassword}
                              onChange={(e) => setSessionConfirmPassword(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && handleCreateSession()}
                              placeholder="Confirm transfer password"
                              className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent"
                              disabled={sessionFetcher.state !== "idle"}
                            />
                          </div>
                          <button
                            onClick={handleCreateSession}
                            disabled={sessionFetcher.state !== "idle" || !sessionPassword || !sessionConfirmPassword}
                            style={sessionFetcher.state === "idle" && sessionPassword && sessionConfirmPassword ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                            className={`w-full px-5 py-3 text-sm rounded-lg transition-all ${sessionFetcher.state === "idle" && sessionPassword && sessionConfirmPassword ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                          >
                            {sessionFetcher.state !== "idle" ? (
                              <span className="flex items-center justify-center gap-2">
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                                Generating...
                              </span>
                            ) : "Generate Session Code"}
                          </button>
                        </div>
                      ) : (
                        // Post-generation: show code + countdown
                        <div className="space-y-4">
                          <div className="text-center">
                            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Your Session Code</p>
                            <div className="inline-flex items-center justify-center rounded-xl px-8 py-5 border-2" style={{ borderColor: "rgba(46,99,22,0.3)", background: "rgba(46,99,22,0.05)" }}>
                              <span className="font-mono text-4xl font-bold tracking-[0.3em]" style={{ color: S }}>{sessionCode}</span>
                            </div>
                            {sessionCountdown !== null && sessionCountdown > 0 && (
                              <div className="mt-3 flex items-center justify-center gap-1.5">
                                <svg className="w-3.5 h-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10"/><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2"/></svg>
                                <span className="text-xs font-medium text-amber-600">
                                  Expires in {String(Math.floor(sessionCountdown / 60)).padStart(2, "0")}:{String(sessionCountdown % 60).padStart(2, "0")}
                                </span>
                              </div>
                            )}
                          </div>

                          {!sessionStorageAvailable && (
                            <p className="text-xs text-amber-600 text-center">
                              Browser storage is restricted in this context — your code won&apos;t survive a page reload. Note it down before sharing.
                            </p>
                          )}

                          <div className="rounded-lg px-4 py-3 bg-blue-50 border border-blue-200">
                            <p className="text-xs font-semibold text-blue-800 mb-1">Share with the destination store owner:</p>
                            <ul className="text-xs text-blue-700 space-y-0.5 list-disc list-inside">
                              <li>Session code: <strong className="font-mono">{sessionCode}</strong></li>
                              <li>The password you just set</li>
                              <li>Ask them to open Importzo → Transfer Store → &ldquo;I&apos;m the Destination Store&rdquo;</li>
                            </ul>
                          </div>

                          <p className="text-xs text-gray-500 text-center">
                            Once the destination store connects using this code, the transfer will proceed on their side. You don&apos;t need to do anything else.
                          </p>

                          <button onClick={handleCancelSession}
                            className="w-full px-4 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                          >
                            Cancel Session
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ STEP 1: SCOPE ═══ */}
        {step === STEP_SCOPE && (
          <div className="animate-fade-in space-y-5">
            {/* Connected store banner */}
            {sourceInfo && (
              <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm flex items-center gap-3 flex-wrap">
                <div className="w-9 h-9 rounded-full bg-green-50 flex items-center justify-center">
                  <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{sourceInfo.shopName}</p>
                  <p className="text-xs text-gray-500">{sourceInfo.productCount} products · {sourceInfo.collectionCount} collections · {sourceInfo.themeCount} themes</p>
                </div>
                <button onClick={() => { resetAll(); }} className="text-xs font-medium text-gray-500 hover:text-gray-700 px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">Change</button>
              </div>
            )}

            {/* Scope selection */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h3 className="text-base font-semibold text-gray-900 mb-1" style={{ fontFamily: F }}>Choose transfer scope</h3>
              <p className="text-sm text-gray-500 mb-5">Transfer everything or select specific data types.</p>

              {/* Full / Custom toggle */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                {[
                  { val: "full", label: "Full Store Transfer", desc: "Transfer all supported data types", badge: "Recommended" },
                  { val: "custom", label: "Custom Selection", desc: "Choose specific modules to transfer" },
                ].map((opt) => (
                  <button key={opt.val} onClick={() => { setScope(opt.val); if (opt.val === "full") setSelectedModules(new Set(AVAILABLE_KEYS)); }}
                    className={`text-left p-4 rounded-xl border-2 transition-all ${scope === opt.val ? "border-green-700/40 bg-green-50/30" : "border-gray-200 bg-white hover:border-gray-300"}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-semibold text-gray-900">{opt.label}</p>
                      {opt.badge && <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider" style={{ background: "rgba(23,50,10,0.1)", color: S }}>{opt.badge}</span>}
                    </div>
                    <p className="text-xs text-gray-500">{opt.desc}</p>
                  </button>
                ))}
              </div>

              {/* Module list */}
              {scope === "custom" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 mb-3">
                    <button onClick={() => setSelectedModules(new Set(AVAILABLE_KEYS))} className="text-xs font-medium px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50" style={{ color: S }}>Select All</button>
                    <button onClick={() => setSelectedModules(new Set())} className="text-xs font-medium text-gray-500 px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50">Clear All</button>
                  </div>
                  {MODULES.map((mod) => (
                    <label key={mod.key} htmlFor={`transfer-mod-${mod.key}`} aria-label={mod.label}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${mod.protected ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} ${selectedModules.has(mod.key) && mod.available ? "border-green-200 bg-green-50/30" : "border-gray-200 bg-white"}`}
                    >
                      <input id={`transfer-mod-${mod.key}`} type="checkbox" checked={selectedModules.has(mod.key)} onChange={() => mod.available && toggleModule(mod.key)}
                        disabled={!mod.available} className="w-4 h-4 rounded" style={{ accentColor: P }} />
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: mod.protected ? "#f3f4f6" : "rgba(23,50,10,0.08)", color: mod.protected ? "#9ca3af" : S }}>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={mod.icon} /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900">{mod.label}</p>
                          {mod.protected && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Protected</span>}
                        </div>
                        <p className="text-xs text-gray-500">{mod.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => { resetAll(); }} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={() => setStep(STEP_CONFIGURE)} disabled={activeModules.length === 0}
                style={activeModules.length > 0 ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                className={`px-5 py-2.5 text-sm rounded-lg transition-all ${activeModules.length > 0 ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
              >Continue &mdash; {activeModules.length} Module{activeModules.length !== 1 ? "s" : ""}</button>
            </div>
          </div>
        )}

        {/* ═══ STEP 2: CONFIGURE ═══ */}
        {step === STEP_CONFIGURE && (
          <div className="animate-fade-in space-y-5">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h3 className="text-base font-semibold text-gray-900 mb-4" style={{ fontFamily: F }}>Transfer Options</h3>

              {/* Dry Run */}
              <label className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 mb-3">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: P }} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">Dry Run Mode</p>
                  <p className="text-xs text-gray-500">Simulate the transfer without making any changes. See what would happen before committing.</p>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-blue-50 text-blue-700">Safe</span>
              </label>

              {/* Conflict handling */}
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-700 mb-2">When destination data already exists:</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { val: "skip", label: "Skip Duplicates", desc: "Leave existing data unchanged" },
                    { val: "create", label: "Create New", desc: "Always create as new items" },
                    { val: "overwrite", label: "Overwrite", desc: "Replace existing data" },
                  ].map((opt) => (
                    <button key={opt.val} onClick={() => setConflictMode(opt.val)}
                      className={`text-left p-3 rounded-lg border-2 transition-all ${conflictMode === opt.val ? "border-green-700/40 bg-green-50/30" : "border-gray-200 bg-white hover:border-gray-300"}`}
                    >
                      <p className="text-xs font-semibold text-gray-900">{opt.label}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</p>
                      {opt.val === "overwrite" && conflictMode === "overwrite" && (
                        <p className="text-[10px] text-amber-600 font-medium mt-1">May overwrite existing data</p>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Market-scoped transfer (Phase 4.2) — only relevant to the products module */}
              {selectedModules.has("products") && sourceInfo?.markets?.length > 0 && (
                <div className="border-t border-gray-100 pt-4 mb-4">
                  <p className="text-sm font-medium text-gray-700 mb-2">Limit products to a source Market (optional):</p>
                  <select
                    value={selectedMarketId}
                    onChange={(e) => setSelectedMarketId(e.target.value)}
                    className="w-full max-w-sm px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-green-800/20 bg-white text-gray-700"
                  >
                    <option value="">All products (no market filter)</option>
                    {sourceInfo.markets.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.hasProductFilter}>
                        {m.name} ({m.currencyCode || "—"}){!m.hasProductFilter ? " — no product restriction configured" : ""}
                      </option>
                    ))}
                  </select>
                  {selectedMarketId && (
                    <p className="text-xs text-gray-500 mt-2">
                      Only products published to this market&apos;s catalog will be transferred, and transferred products will be tagged <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700">market:{sourceInfo.markets.find((m) => m.id === selectedMarketId)?.handle}</code>.
                    </p>
                  )}
                  {!selectedMarketId && (
                    <p className="text-xs text-gray-400 mt-2">
                      Markets without a dedicated catalog make every product available to them, so there&apos;s nothing to filter by — those are shown disabled above.
                    </p>
                  )}
                </div>
              )}

              {/* Theme selection */}
              {selectedModules.has("themes") && sourceInfo?.themes?.length > 0 && (
                <div className="border-t border-gray-100 pt-4">
                  <p className="text-sm font-medium text-gray-700 mb-2">Theme to transfer:</p>
                  <div className="space-y-2">
                    {sourceInfo.themes.map((theme) => (
                      <label key={theme.id} className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${selectedThemeId === theme.id ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}>
                        <input type="radio" name="theme" checked={selectedThemeId === theme.id} onChange={() => setSelectedThemeId(theme.id)} style={{ accentColor: P }} />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">{theme.name}</p>
                          <p className="text-xs text-gray-500">{theme.role === "main" ? "Live theme" : "Unpublished"}</p>
                        </div>
                        {theme.role === "main" && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700">Live</span>}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">Theme will be transferred as an <strong>unpublished theme</strong>. You can publish it manually after reviewing.</p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_SCOPE)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={() => setStep(STEP_PREVIEW)}
                style={{ background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]"
              >Continue to Preview</button>
            </div>
          </div>
        )}

        {/* ═══ STEP 3: PREVIEW ═══ */}
        {step === STEP_PREVIEW && (
          <div className="animate-fade-in space-y-5">
            {/* Dry run info banner — replaced raw blue div with shared info banner pattern */}
            {dryRun && (
              <div className="rounded-xl px-5 py-4 border-2 border-blue-200 bg-blue-50/50 flex items-start gap-3" role="status" aria-live="polite">
                <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
                <div>
                  <p className="text-sm font-semibold text-blue-800">Dry Run Mode Active</p>
                  <p className="text-xs text-blue-600 mt-0.5">No data will be created or modified. This is a simulation only.</p>
                </div>
              </div>
            )}

            {/* Impact summary */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h3 className="text-base font-semibold text-gray-900 mb-4" style={{ fontFamily: F }}>Transfer Summary</h3>

              {/* Source → Destination row */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-3 mb-5">
                <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">From — Source</p>
                  <p className="text-sm font-semibold text-gray-900 mt-0.5 truncate">{sourceInfo?.shopName || "—"}</p>
                  <p className="text-[11px] text-gray-500 truncate">{sourceInfo?.shopDomain || ""}</p>
                </div>
                <svg className="w-6 h-6 text-gray-400 mx-auto hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
                <div className="rounded-lg border-2 px-4 py-3" style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: S }}>Into — Destination (Current)</p>
                  <p className="text-sm font-semibold text-gray-900 mt-0.5 truncate">{destinationName}</p>
                  <p className="text-[11px] text-gray-500 truncate">{currentShop}</p>
                </div>
              </div>

              <div className="space-y-3 mb-5">
                <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-gray-50">
                  <span className="text-sm font-medium text-gray-700">Conflict handling:</span>
                  <span className="text-sm text-gray-900">{conflictMode === "skip" ? "Skip duplicates" : conflictMode === "create" ? "Create new copies" : "Overwrite existing"}</span>
                </div>
                <p className="text-[11px] text-gray-500 px-4">
                  New items created in the destination are additive — nothing is deleted from either store.
                </p>
              </div>

              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Modules to transfer</p>
              <div className="space-y-2">
                {activeModules.map((key) => {
                  const mod = MODULES.find((m) => m.key === key);
                  const count = key === "collections" ? sourceInfo?.collectionCount : key === "products" ? sourceInfo?.productCount : key === "themes" ? 1 : key === "content" ? "Pages/Blogs/Files" : "—";
                  return (
                    <div key={key} className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={mod?.icon} /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">{mod?.label}</p>
                        <p className="text-xs text-gray-500">{mod?.desc}</p>
                      </div>
                      <span className="text-sm font-semibold text-gray-700 tabular-nums">{count}</span>
                    </div>
                  );
                })}
              </div>

              {/* Overwrite warning banner — replaced raw amber div; role="alert" matches Polaris Banner warning semantics */}
              {conflictMode === "overwrite" && (
                <div className="mt-4 rounded-lg px-4 py-3 bg-amber-50 border border-amber-200" role="alert">
                  <p className="text-xs font-semibold text-amber-800">Warning: Overwrite mode</p>
                  <p className="text-xs text-amber-700 mt-0.5">Existing products and collections with matching handles may be overwritten. This cannot be undone.</p>
                </div>
              )}

              {/* Theme info banner — replaced raw blue div; role="status" matches Polaris Banner info semantics */}
              {selectedModules.has("themes") && (
                <div className="mt-4 rounded-lg px-4 py-3 bg-blue-50 border border-blue-200" role="status">
                  <p className="text-xs text-blue-700">Theme will be transferred as <strong>unpublished</strong>. Review it before publishing.</p>
                </div>
              )}
            </div>

            <label className="flex items-start gap-3 px-4 py-3 rounded-lg border border-gray-200 bg-white cursor-pointer select-none">
              <input
                type="checkbox"
                checked={ownershipConsent}
                onChange={(e) => setOwnershipConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-green-700 flex-shrink-0"
              />
              <span className="text-sm text-gray-700">
                I confirm that I own or have the right to transfer all data from the source store.
              </span>
            </label>

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_CONFIGURE)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={startTransfer} disabled={!ownershipConsent}
                style={{ background: ownershipConsent ? (dryRun ? "#2563eb" : P) : undefined, color: ownershipConsent ? "#fff" : undefined, borderRadius: 8, fontWeight: 600, fontFamily: F }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >{dryRun ? "Start Dry Run" : `Start Transfer — ${activeModules.length} Module${activeModules.length !== 1 ? "s" : ""}`}</button>
            </div>
          </div>
        )}

        {/* ═══ STEP 4: TRANSFER ═══ */}
        {step === STEP_TRANSFER && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-8 shadow-sm max-w-2xl mx-auto">
              <div className="flex flex-col items-center gap-5">
                <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
                  <svg className="w-8 h-8 animate-spin" style={{ color: P }} fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <div className="text-center w-full">
                  <h3 className="text-lg font-semibold text-gray-900">{dryRun ? "Running dry run..." : "Transferring store data..."}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Do not close this page.{transferElapsed > 0 ? ` · ${Math.floor(transferElapsed / 60)}m ${transferElapsed % 60}s` : ""}
                  </p>
                  {transferElapsed >= 30 && !dryRun && (
                    <p className="text-xs text-amber-600 mt-1">Large stores can take several minutes — still working.</p>
                  )}

                  {/* Module progress */}
                  <div className="mt-6 space-y-2 text-left">
                    {activeModules.map((key) => {
                      const mod = MODULES.find((m) => m.key === key);
                      const stats = getModuleStats(key);
                      const isCurrent = currentModule === key;
                      const isDone = !!stats;
                      return (
                        <div key={key} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-50">
                          {isDone ? (
                            <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                          ) : isCurrent ? (
                            <svg className="w-5 h-5 animate-spin flex-shrink-0" style={{ color: P }} fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                          ) : (
                            <div className="w-5 h-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                          )}
                          <span className={`text-sm font-medium flex-1 ${isDone ? "text-green-700" : isCurrent ? "text-gray-900" : "text-gray-400"}`}>{mod?.label}</span>
                          {isDone && stats && <span className="text-xs text-gray-500">{key === "themes" ? `${stats.success} / ${stats.total} assets` : `${stats.success} ok${stats.errors > 0 ? `, ${stats.errors} err` : ""}`}</span>}
                          {isCurrent && moduleProgress.total > 0 && <span className="text-xs text-gray-500">{moduleProgress.idx}/{moduleProgress.total}</span>}
                        </div>
                      );
                    })}
                  </div>

                  {loadingMsg && <p className="text-xs text-gray-400 mt-3">{loadingMsg}</p>}
                  {(() => {
                    const completedCount = activeModules.filter((k) => !!getModuleStats(k)).length;
                    // Add partial within-module progress for collections (they come back one at a time)
                    let partial = 0;
                    if (currentModule === "collections" && moduleProgress.total > 0) {
                      partial = (moduleProgress.idx - 1) / moduleProgress.total;
                    }
                    const pct = activeModules.length > 0 ? Math.min(99, Math.round(((completedCount + partial) / activeModules.length) * 100)) : 0;
                    const displayPct = completedCount === activeModules.length ? 100 : pct;
                    return (
                      <div className="mt-3 w-full">
                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                          <span>{completedCount} / {activeModules.length} modules complete</span>
                          <span>{displayPct}%</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${displayPct}%`, background: P }} />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ STEP 5: RESULTS ═══ */}
        {step === STEP_RESULTS && (
          <div className="animate-fade-in space-y-5">
            {/* Results status banners — dry-run info and transfer success replaced with role-annotated banners */}
            {dryRun ? (
              <div className="rounded-xl px-5 py-4 border-2 border-blue-200 bg-blue-50/50 flex items-center gap-3" role="status" aria-live="polite">
                <svg className="w-5 h-5 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
                <p className="text-sm font-semibold text-blue-800">Dry Run Results — No data was modified in {destinationName}</p>
              </div>
            ) : !error ? (
              <div className="rounded-xl px-5 py-4 border-2 flex items-center gap-3" style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }} role="status" aria-live="polite">
                <svg className="w-5 h-5 flex-shrink-0" style={{ color: S }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-semibold" style={{ color: P }}>
                    Transfer complete — data has been copied into {destinationName}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    From <strong>{sourceInfo?.shopName || "source"}</strong> into your current store. Open the Shopify admin to review the new items.
                  </p>
                </div>
              </div>
            ) : null}

            {/* Summary stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {(() => {
                let totalSuccess = 0, totalErrors = 0, totalItems = 0;
                for (const key of activeModules) {
                  const s = getModuleStats(key);
                  if (s) { totalItems += s.total; totalSuccess += s.success + s.dryRun; totalErrors += s.errors; }
                }
                return (
                  <>
                    <div className="bg-white rounded-xl border border-green-200 p-5 shadow-sm">
                      <p className="text-2xl font-bold text-gray-900">{totalSuccess}</p>
                      <p className="text-sm text-green-600 font-medium">{dryRun ? "Would Transfer" : "Transferred"}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                      <p className="text-2xl font-bold text-gray-900">{totalItems}</p>
                      <p className="text-sm text-gray-600 font-medium">Total Items</p>
                    </div>
                    {totalErrors > 0 && (
                      <div className="bg-white rounded-xl border border-red-200 p-5 shadow-sm">
                        <p className="text-2xl font-bold text-gray-900">{totalErrors}</p>
                        <p className="text-sm text-red-600 font-medium">Errors</p>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Per-module results */}
            {activeModules.map((key) => {
              const mod = MODULES.find((m) => m.key === key);
              const stats = getModuleStats(key);
              if (!stats) return null;
              return (
                <div key={key} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={mod?.icon} /></svg>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{mod?.label}</p>
                        <p className="text-xs text-gray-500">{stats.total} total · {stats.success + stats.dryRun} {dryRun ? "validated" : "transferred"}{stats.errors > 0 ? ` · ${stats.errors} failed` : ""}</p>
                      </div>
                    </div>
                    {stats.errors > 0 && (
                      <button onClick={() => downloadErrors(key)} className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-red-600">
                        Download Errors
                      </button>
                    )}
                  </div>

                  {/* Show error details for collections */}
                  {key === "collections" && transferResults.collections?.items && (
                    <div className="divide-y divide-gray-100 max-h-[300px] overflow-auto">
                      {transferResults.collections.items.map((col, i) => {
                        const ok = col.products.filter((p) => p.status === "success" || p.status === "dry-run").length;
                        const errs = col.products.filter((p) => p.status === "error").length;
                        return (
                          <div key={i} className="px-6 py-3 flex items-center gap-3">
                            {col.collectionError ? (
                              <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                            ) : (
                              <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                            )}
                            <span className="text-sm text-gray-700 flex-1 truncate">{col.collectionTitle}</span>
                            <span className="text-xs text-gray-400">{ok} ok{errs > 0 ? `, ${errs} err` : ""}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Product/theme summary */}
                  {key === "products" && stats.errors > 0 && transferResults.products?.results && (
                    <div className="divide-y divide-gray-100 max-h-[200px] overflow-auto">
                      {transferResults.products.results.filter((p) => p.status === "error").map((p, i) => (
                        <div key={i} className="px-6 py-2 flex items-center gap-3 text-sm">
                          <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          <span className="text-gray-900 truncate flex-1">{p.title}</span>
                          <span className="text-xs text-red-600 truncate max-w-[200px]">{p.error}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Phase 6 — fuzzy duplicate warnings (dry-run preview only, advisory).
                      Never blocks the transfer; the merchant decides skip / create anyway / merge
                      themselves via conflictMode or by editing the source before running for real. */}
                  {key === "products" && dryRun && transferResults.products?.results?.some((p) => p.similarTo) && (
                    <div className="border-t border-amber-100 bg-amber-50/40">
                      <div className="px-6 py-2 text-xs font-semibold text-amber-700">
                        Possible duplicates — looks similar to a product already in this store
                      </div>
                      <div className="divide-y divide-amber-100 max-h-[200px] overflow-auto">
                        {transferResults.products.results.filter((p) => p.similarTo).map((p, i) => (
                          <div key={i} className="px-6 py-2 flex items-center gap-3 text-sm">
                            <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                            <span className="text-gray-900 truncate flex-1">{p.title}</span>
                            <span className="text-xs text-amber-700 truncate max-w-[220px]">looks like &quot;{p.similarTo}&quot;</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {key === "themes" && transferResults.themes && (
                    <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60">
                      {transferResults.themes.ok && transferResults.themes.dryRun ? (
                        // ── Dry-run result — no destination store touched ──
                        <div className="flex items-center gap-3 rounded-lg px-4 py-3" style={{ background: "rgba(37,99,235,0.05)", border: "1px solid rgba(37,99,235,0.2)" }}>
                          <svg className="w-5 h-5 flex-shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-blue-800">Dry run — no changes made</p>
                            <p className="text-xs text-blue-700 mt-0.5">
                              Theme &quot;{transferResults.themes.themeName}&quot; has <strong>{transferResults.themes.assetCount}</strong> assets that would be transferred. No theme was created on the destination store.
                            </p>
                          </div>
                        </div>
                      ) : transferResults.themes.ok && transferResults.themes.newThemeId ? (
                        // ── Real transfer success ──
                        <div className="space-y-3">
                          <div className="flex items-center gap-3 rounded-lg px-4 py-3" style={{ background: "rgba(46,99,22,0.06)", border: "1px solid rgba(46,99,22,0.15)" }}>
                            <svg className="w-5 h-5 flex-shrink-0" style={{ color: S }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-gray-900">
                                Theme &quot;{transferResults.themes.newThemeName || transferResults.themes.themeName}&quot; created in {destinationName}
                              </p>
                              <p className="text-xs text-gray-600 mt-0.5">Saved as <strong>unpublished</strong> — preview it before publishing.</p>
                            </div>
                            <div className="flex flex-col gap-1.5 flex-shrink-0">
                            <a href={`https://${currentShop}/admin/themes/${transferResults.themes.newThemeId}`} target="_blank" rel="noopener noreferrer"
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white whitespace-nowrap text-center" style={{ background: S }}>
                              Open Theme ↗
                            </a>
                            {transferResults.themes?.previewUrl && (
                              <a href={transferResults.themes.previewUrl} target="_blank" rel="noopener noreferrer"
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap text-center border" style={{ color: S, borderColor: "rgba(46,99,22,0.3)" }}>
                                Preview ↗
                              </a>
                            )}
                          </div>
                          </div>
                          <p className="text-[11px] text-gray-500">
                            Asset copy: {stats.success} succeeded
                            {stats.errors > 0 ? `, ${stats.errors} failed` : ""}
                            {(transferResults.themes.results || []).filter((a) => a.status === "warning").length > 0
                              ? `, ${(transferResults.themes.results || []).filter((a) => a.status === "warning").length} CDN warnings`
                              : ""}.
                            Theme is still usable — failed assets are typically large binary files.
                          </p>
                        </div>
                      ) : (
                        // ── Error ──
                        <p className="text-xs text-red-600">
                          Theme creation failed on the destination store: {friendlyError(transferResults.themes.error)}
                        </p>
                      )}

                      {stats.errors > 0 && transferResults.themes?.results?.length > 0 && (
                        <details className="mt-3">
                          <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-700">Show failing assets ({stats.errors})</summary>
                          <div className="mt-2 divide-y divide-gray-100 max-h-[200px] overflow-auto bg-white rounded-lg border border-gray-100">
                            {(transferResults.themes.results || []).filter((a) => a.status === "error").slice(0, 50).map((a, i) => (
                              <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                                <span className="text-gray-900 truncate flex-1 font-mono">{a.key}</span>
                                <span className="text-red-600 truncate max-w-[240px]">{friendlyError(a.error)}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {key === "content" && transferResults.content?.results && (
                    <div className="divide-y divide-gray-100 max-h-[260px] overflow-auto">
                      {transferResults.content.results.slice(0, 80).map((item, i) => (
                        <div key={i} className="px-6 py-2 flex items-center gap-3 text-sm">
                          {item.status === "error" ? (
                            <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          ) : item.status === "warning" || item.warnings?.length ? (
                            <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM2.25 18.75h19.5L12 3.75 2.25 18.75z" /></svg>
                          ) : (
                            <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                          )}
                          <span className="text-xs uppercase tracking-wide text-gray-400 w-20 flex-shrink-0">{item.type}</span>
                          <span className="text-gray-900 truncate flex-1">{item.title}</span>
                          {item.copied !== undefined && <span className="text-xs text-gray-500">{item.copied}/{item.total}</span>}
                          {item.totalArticles !== undefined && <span className="text-xs text-gray-500">{item.totalArticles} articles</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Human-friendly failure summary for product / collection failures */}
                  {key !== "themes" && stats.errors > 0 && (() => {
                    let rawErrors = [];
                    if (key === "collections" && transferResults.collections?.items) {
                      rawErrors = transferResults.collections.items.flatMap((c) => c.products.filter((p) => p.status === "error"));
                    } else if (key === "products" && transferResults.products?.results) {
                      rawErrors = transferResults.products.results.filter((p) => p.status === "error");
                    }
                    const groups = summarizeFailures(rawErrors);
                    if (groups.length === 0) return null;
                    return (
                      <div className="px-6 py-3 border-t border-gray-100 bg-amber-50/40">
                        <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider mb-1.5">Why some items failed</p>
                        <ul className="space-y-1">
                          {groups.slice(0, 5).map((g, i) => (
                            <li key={i} className="text-xs text-gray-700 flex items-start gap-2">
                              <span className="inline-flex items-center justify-center min-w-[22px] h-[18px] px-1 rounded text-[10px] font-semibold bg-amber-100 text-amber-800">{g.count}</span>
                              <span className="flex-1">{g.message}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-[11px] text-gray-500 mt-2">
                          Successful items were still created in {destinationName}. Download the full error CSV to retry failed ones.
                        </p>
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button onClick={resetAll} style={{ background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all">New Transfer</button>
              <Link to="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back to Dashboard</Link>
              {dryRun && (
                <button onClick={() => { setDryRun(false); setStep(STEP_PREVIEW); setTransferResults({}); transferResultsRef.current = {}; savingRecord.current = false; }}
                  style={{ background: S, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
                  className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all">Run for Real</button>
              )}
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Transfer Store"
      title="We couldn't load Transfer Store"
      message="Something went wrong while preparing your saved connection. You can try again, or contact support if the issue continues."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
