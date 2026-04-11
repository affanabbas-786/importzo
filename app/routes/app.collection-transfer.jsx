import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import {
  getSavedSourceStore,
  upsertSourceStore,
  touchSourceStore,
  deleteSourceStore,
} from "../lib/safe-db";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { loadPrefs } from "../lib/prefs";
import { friendlyError, summarizeFailures } from "../lib/friendly-errors";
import { notifyJobComplete } from "../lib/notify";

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
  const rid = formData.get("rid") || "";

  // Helper: get source credentials from form or saved DB
  async function getSourceCreds() {
    let url = (formData.get("sourceUrl") || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    let token = (formData.get("sourceToken") || "").trim();
    if (!url || !token) {
      const saved = await getSavedSourceStore(session.shop);
      if (saved) { url = saved.sourceUrl; token = saved.token; }
    }
    if (url && !url.includes(".")) url = url + ".myshopify.com";
    return { url, token };
  }

  // Helper: fetch with automatic 429 retry + exponential backoff
  async function shopifyFetch(url, opts = {}) {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get("Retry-After") || "0");
        const delay = Math.max(retryAfter * 1000, 1000 * Math.pow(2, attempt));
        if (attempt < MAX_RETRIES) { await new Promise((r) => setTimeout(r, delay)); continue; }
      }
      return res;
    }
    // Should not reach here, but just in case
    return fetch(url, opts);
  }

  // Helper: paginated REST fetch from any Shopify store (with 429 retry)
  async function fetchAllPages(baseUrl, token) {
    const items = [];
    let url = baseUrl;
    while (url) {
      const res = await shopifyFetch(url, { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const key = Object.keys(data).find((k) => Array.isArray(data[k]));
      if (key) items.push(...data[key]);
      const link = res.headers.get("Link") || "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return items;
  }

  // Helper: look up existing product by handle on target store
  async function findProductByHandle(handle) {
    if (!handle) return null;
    try {
      const res = await shopifyFetch(`https://${targetShop}/admin/api/${version}/products.json?handle=${encodeURIComponent(handle)}&limit=1&fields=id,handle,title`, {
        headers: { "X-Shopify-Access-Token": targetToken },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.products?.[0] || null;
    } catch { return null; }
  }

  // Helper: update an existing product on target store
  async function updateProductOnTarget(existingId, src) {
    const pd = {
      id: existingId,
      title: src.title || "Untitled", body_html: src.body_html || "",
      vendor: src.vendor || "", product_type: src.product_type || "",
      tags: src.tags || "",
    };
    const res = await shopifyFetch(`https://${targetShop}/admin/api/${version}/products/${existingId}.json`, {
      method: "PUT", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
      body: JSON.stringify({ product: pd }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`);
    }
    return { id: existingId, warnings: ["Overwrote existing product"] };
  }

  // Helper: create a single product on target store (with conflict mode)
  const conflictMode = formData.get("conflictMode") || "create";

  async function createProductOnTarget(src) {
    // Conflict detection: look up by handle
    if (src.handle && conflictMode !== "create") {
      const existing = await findProductByHandle(src.handle);
      if (existing) {
        if (conflictMode === "skip") {
          return { id: existing.id, warnings: ["Skipped — product already exists"], skipped: true };
        }
        if (conflictMode === "overwrite") {
          return await updateProductOnTarget(existing.id, src);
        }
      }
    }

    const pd = {
      title: src.title || "Untitled", body_html: src.body_html || "",
      vendor: src.vendor || "", product_type: src.product_type || "",
      tags: src.tags || "", handle: src.handle || "", published: !!src.published_at,
    };
    if (src.options?.length > 0) pd.options = src.options.map((o) => ({ name: o.name }));
    if (src.variants?.length > 0) {
      pd.variants = src.variants.map((v) => {
        const vd = {};
        if (v.option1) vd.option1 = v.option1;
        if (v.option2) vd.option2 = v.option2;
        if (v.option3) vd.option3 = v.option3;
        if (v.price) vd.price = v.price;
        if (v.compare_at_price) vd.compare_at_price = v.compare_at_price;
        if (v.sku) vd.sku = v.sku;
        if (v.barcode) vd.barcode = v.barcode;
        if (v.weight) vd.weight = v.weight;
        if (v.weight_unit) vd.weight_unit = v.weight_unit;
        if (v.inventory_quantity !== undefined) vd.inventory_quantity = v.inventory_quantity;
        if (v.inventory_policy) vd.inventory_policy = v.inventory_policy;
        if (v.fulfillment_service) vd.fulfillment_service = v.fulfillment_service;
        vd.requires_shipping = v.requires_shipping !== false;
        vd.taxable = v.taxable !== false;
        return vd;
      });
    }
    const validImages = (src.images || []).filter((img) => img.src && /^https?:\/\//i.test(img.src)).slice(0, 250).map((img) => ({ src: img.src }));
    if (validImages.length > 0) pd.images = validImages;

    let warnings = [];
    let createRes = await shopifyFetch(`https://${targetShop}/admin/api/${version}/products.json`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
      body: JSON.stringify({ product: pd }),
    });
    if (!createRes.ok && pd.images) {
      warnings.push("Images failed — product created without images");
      delete pd.images;
      createRes = await shopifyFetch(`https://${targetShop}/admin/api/${version}/products.json`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
        body: JSON.stringify({ product: pd }),
      });
    }
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${createRes.status}`);
    }
    const created = (await createRes.json()).product;
    return { id: created.id, warnings };
  }

  // ── Connect & verify source store ──
  if (intent === "connect") {
    const { url, token } = await getSourceCreds();
    if (!url) return { intent: "connect", rid, ok: false, error: "Please enter your source store URL" };
    if (!token) return { intent: "connect", rid, ok: false, error: "Please enter the Admin API access token" };

    try {
      const res = await fetch(`https://${url}/admin/api/${version}/shop.json`, { headers: { "X-Shopify-Access-Token": token } });
      if (res.status === 401 || res.status === 403) throw new Error("Invalid access token. Make sure you copied the full token starting with shpat_");
      if (res.status === 404) throw new Error("Store not found. Check the URL.");
      if (!res.ok) throw new Error(`Connection failed (HTTP ${res.status}).`);
      const data = await res.json();
      const shopName = data.shop?.name || url;
      const shopEmail = data.shop?.email || "";
      const shopPlan = data.shop?.plan_display_name || "";

      // Fetch counts in parallel
      const [pc, cc1, cc2, tc] = await Promise.all([
        fetch(`https://${url}/admin/api/${version}/products/count.json`, { headers: { "X-Shopify-Access-Token": token } }),
        fetch(`https://${url}/admin/api/${version}/custom_collections/count.json`, { headers: { "X-Shopify-Access-Token": token } }),
        fetch(`https://${url}/admin/api/${version}/smart_collections/count.json`, { headers: { "X-Shopify-Access-Token": token } }),
        fetch(`https://${url}/admin/api/${version}/themes.json`, { headers: { "X-Shopify-Access-Token": token } }),
      ]);
      const productCount = pc.ok ? (await pc.json()).count : 0;
      const collectionCount = (cc1.ok ? (await cc1.json()).count : 0) + (cc2.ok ? (await cc2.json()).count : 0);
      let themeCount = 0;
      let themes = [];
      if (tc.ok) { const td = await tc.json(); themes = td.themes || []; themeCount = themes.length; }

      // Save connection to DB (best-effort — never blocks the user)
      const saveToken = formData.get("sourceToken")?.trim() || token;
      await upsertSourceStore(session.shop, {
        sourceUrl: url, sourceName: shopName, sourceEmail: shopEmail, sourcePlan: shopPlan, token: saveToken,
      });

      return {
        intent: "connect", rid, ok: true,
        shopName, shopEmail, shopPlan, shopDomain: url,
        productCount, collectionCount, themeCount, themes,
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
      const res = await fetch(`https://${saved.sourceUrl}/admin/api/${version}/shop.json`, { headers: { "X-Shopify-Access-Token": saved.token } });
      if (!res.ok) throw new Error("Saved credentials are no longer valid. Please reconnect your source store.");
      await touchSourceStore(session.shop);

      const [pc, cc1, cc2, tc] = await Promise.all([
        fetch(`https://${saved.sourceUrl}/admin/api/${version}/products/count.json`, { headers: { "X-Shopify-Access-Token": saved.token } }),
        fetch(`https://${saved.sourceUrl}/admin/api/${version}/custom_collections/count.json`, { headers: { "X-Shopify-Access-Token": saved.token } }),
        fetch(`https://${saved.sourceUrl}/admin/api/${version}/smart_collections/count.json`, { headers: { "X-Shopify-Access-Token": saved.token } }),
        fetch(`https://${saved.sourceUrl}/admin/api/${version}/themes.json`, { headers: { "X-Shopify-Access-Token": saved.token } }),
      ]);
      const productCount = pc.ok ? (await pc.json()).count : 0;
      const collectionCount = (cc1.ok ? (await cc1.json()).count : 0) + (cc2.ok ? (await cc2.json()).count : 0);
      let themeCount = 0;
      let themes = [];
      if (tc.ok) { const td = await tc.json(); themes = td.themes || []; themeCount = themes.length; }

      return {
        intent: "verify-connection", rid, ok: true,
        shopName: saved.sourceName, shopEmail: saved.sourceEmail, shopPlan: saved.sourcePlan, shopDomain: saved.sourceUrl,
        productCount, collectionCount, themeCount, themes,
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
      const custom = await fetchAllPages(`https://${url}/admin/api/${version}/custom_collections.json?limit=250`, token);
      const smart = await fetchAllPages(`https://${url}/admin/api/${version}/smart_collections.json?limit=250`, token);
      const collections = [];
      for (const c of custom) {
        let productCount = 0;
        try { const r = await fetch(`https://${url}/admin/api/${version}/products/count.json?collection_id=${c.id}`, { headers: { "X-Shopify-Access-Token": token } }); if (r.ok) productCount = (await r.json()).count || 0; } catch (_) { }
        collections.push({ id: c.id, title: c.title, handle: c.handle, body_html: c.body_html || "", image: c.image?.src || "", published: !!c.published_at, sort_order: c.sort_order || "", type: "custom", productCount });
      }
      for (const c of smart) {
        let productCount = 0;
        try { const r = await fetch(`https://${url}/admin/api/${version}/products/count.json?collection_id=${c.id}`, { headers: { "X-Shopify-Access-Token": token } }); if (r.ok) productCount = (await r.json()).count || 0; } catch (_) { }
        collections.push({ id: c.id, title: c.title, handle: c.handle, body_html: c.body_html || "", image: c.image?.src || "", published: !!c.published_at, sort_order: c.sort_order || "", type: "smart", rules: c.rules || [], disjunctive: c.disjunctive || false, productCount });
      }
      return { intent: "fetch-collections", rid, ok: true, collections };
    } catch (err) {
      return { intent: "fetch-collections", rid, ok: false, error: err.message };
    }
  }

  // ── Transfer ONE collection with ALL its products ──
  if (intent === "transfer") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    const col = JSON.parse(formData.get("collection"));
    const dryRun = formData.get("dryRun") === "true";
    const out = { collectionId: col.id, collectionTitle: col.title, collectionType: col.type, newCollectionId: null, collectionWarning: null, collectionError: null, products: [] };

    if (dryRun) {
      // Dry run — count products without creating anything
      try {
        const products = await fetchAllPages(`https://${sourceUrl}/admin/api/${version}/collections/${col.id}/products.json?limit=250`, sourceToken);
        out.products = products.map((p) => ({ sourceId: p.id, title: p.title, status: "dry-run", error: null, warnings: [] }));
      } catch (err) { out.collectionError = err.message; }
      return { intent: "transfer", rid, ok: true, result: out };
    }

    try {
      let newColId = null;
      if (col.type === "smart") {
        const body = { smart_collection: { title: col.title, body_html: col.body_html || "", published: col.published, sort_order: col.sort_order || "alpha-asc", rules: col.rules?.length > 0 ? col.rules : [{ column: "tag", relation: "equals", condition: col.title || "imported" }], disjunctive: col.disjunctive || false } };
        if (col.image) body.smart_collection.image = { src: col.image };
        let res = await fetch(`https://${targetShop}/admin/api/${version}/smart_collections.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken }, body: JSON.stringify(body) });
        if (!res.ok && col.image) { delete body.smart_collection.image; out.collectionWarning = "Collection image skipped"; res = await fetch(`https://${targetShop}/admin/api/${version}/smart_collections.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken }, body: JSON.stringify(body) }); }
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`); }
        newColId = (await res.json()).smart_collection.id;
      } else {
        const body = { custom_collection: { title: col.title, body_html: col.body_html || "", published: col.published, sort_order: col.sort_order || "" } };
        if (col.image) body.custom_collection.image = { src: col.image };
        let res = await fetch(`https://${targetShop}/admin/api/${version}/custom_collections.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken }, body: JSON.stringify(body) });
        if (!res.ok && col.image) { delete body.custom_collection.image; out.collectionWarning = "Collection image skipped"; res = await fetch(`https://${targetShop}/admin/api/${version}/custom_collections.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken }, body: JSON.stringify(body) }); }
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`); }
        newColId = (await res.json()).custom_collection.id;
      }
      out.newCollectionId = newColId;

      const sourceProducts = await fetchAllPages(`https://${sourceUrl}/admin/api/${version}/collections/${col.id}/products.json?limit=250`, sourceToken);
      for (const src of sourceProducts) {
        const pr = { sourceId: src.id, title: src.title, status: "success", error: null, warnings: [] };
        try {
          const { id: newId, warnings } = await createProductOnTarget(src);
          pr.newProductId = newId;
          pr.warnings = warnings;
          if (col.type !== "smart" && newColId) {
            try {
              const collectRes = await fetch(`https://${targetShop}/admin/api/${version}/collects.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken }, body: JSON.stringify({ collect: { product_id: newId, collection_id: newColId } }) });
              if (!collectRes.ok) pr.warnings.push("Could not link to collection");
            } catch (_) { pr.warnings.push("Collection link failed"); }
          }
        } catch (err) { pr.status = "error"; pr.error = err.message; }
        out.products.push(pr);
      }
    } catch (err) { out.collectionError = err.message; }
    return { intent: "transfer", rid, ok: true, result: out };
  }

  // ── Transfer standalone products (not in any collection) ──
  if (intent === "transfer-products") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    const dryRun = formData.get("dryRun") === "true";
    const skipCollectionProducts = formData.get("skipCollectionProducts") === "true";

    try {
      const allProducts = await fetchAllPages(`https://${sourceUrl}/admin/api/${version}/products.json?limit=250`, sourceToken);
      let productsToTransfer = allProducts;

      if (skipCollectionProducts) {
        const collProductIds = new Set();
        const custom = await fetchAllPages(`https://${sourceUrl}/admin/api/${version}/custom_collections.json?limit=250&fields=id`, sourceToken);
        const smart = await fetchAllPages(`https://${sourceUrl}/admin/api/${version}/smart_collections.json?limit=250&fields=id`, sourceToken);
        for (const col of [...custom, ...smart]) {
          try {
            const prods = await fetchAllPages(`https://${sourceUrl}/admin/api/${version}/collections/${col.id}/products.json?limit=250&fields=id`, sourceToken);
            prods.forEach((p) => collProductIds.add(p.id));
          } catch (_) { }
        }
        productsToTransfer = allProducts.filter((p) => !collProductIds.has(p.id));
      }

      if (dryRun) {
        return { intent: "transfer-products", rid, ok: true, total: allProducts.length, transferred: productsToTransfer.length, results: productsToTransfer.map((p) => ({ title: p.title, status: "dry-run" })) };
      }

      const results = [];
      for (const src of productsToTransfer) {
        try {
          const { warnings } = await createProductOnTarget(src);
          results.push({ title: src.title, status: "success", warnings });
        } catch (err) {
          results.push({ title: src.title, status: "error", error: err.message });
        }
      }
      return { intent: "transfer-products", rid, ok: true, total: allProducts.length, transferred: productsToTransfer.length, results };
    } catch (err) {
      return { intent: "transfer-products", rid, ok: false, error: err.message };
    }
  }

  // ── Transfer theme ──
  if (intent === "transfer-theme") {
    const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
    const themeId = formData.get("themeId");
    const themeName = formData.get("themeName") || "Transferred Theme";
    const dryRun = formData.get("dryRun") === "true";

    try {
      // Fetch all assets from source theme (with retry)
      const assetsRes = await shopifyFetch(`https://${sourceUrl}/admin/api/${version}/themes/${themeId}/assets.json`, { headers: { "X-Shopify-Access-Token": sourceToken } });
      if (!assetsRes.ok) throw new Error(`Failed to fetch theme assets: HTTP ${assetsRes.status}`);
      const assetsList = (await assetsRes.json()).assets || [];

      if (dryRun) {
        return { intent: "transfer-theme", rid, ok: true, themeName, assetCount: assetsList.length, results: assetsList.map((a) => ({ key: a.key, status: "dry-run" })) };
      }

      // Create unpublished theme on target (with retry)
      const createRes = await shopifyFetch(`https://${targetShop}/admin/api/${version}/themes.json`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
        body: JSON.stringify({ theme: { name: `${themeName} (Transferred)`, role: "unpublished" } }),
      });
      if (!createRes.ok) { const err = await createRes.json().catch(() => ({})); throw new Error(`Failed to create theme: ${err.errors ? JSON.stringify(err.errors) : createRes.status}`); }
      const newTheme = (await createRes.json()).theme;
      if (!newTheme?.id) throw new Error("Theme creation failed: API did not return a theme ID");

      // Copy each asset with rate-limit handling
      // Process layout/ and config/ files first — Shopify validates theme
      // structure, and missing layouts cause later template uploads to fail.
      const priorityOrder = (key) => {
        if (key.startsWith("layout/")) return 0;
        if (key.startsWith("config/")) return 1;
        if (key.startsWith("sections/")) return 2;
        if (key.startsWith("snippets/")) return 3;
        if (key.startsWith("templates/")) return 4;
        if (key.startsWith("assets/")) return 5;
        return 6;
      };
      const sortedAssets = [...assetsList].sort((a, b) => priorityOrder(a.key) - priorityOrder(b.key));

      // Process assets in parallel batches of 5 — ~5x faster than serial,
      // stays safely within Shopify's REST rate limit (40 req/s bucket).
      const results = [];
      const BATCH = 5;
      const MAX_ASSET_RETRIES = 2;
      for (let i = 0; i < sortedAssets.length; i += BATCH) {
        const slice = sortedAssets.slice(i, i + BATCH);
        const batchResults = await Promise.all(slice.map(async (asset) => {
          let lastResult = null;
          for (let attempt = 0; attempt <= MAX_ASSET_RETRIES; attempt++) {
            try {
              // GET asset from source
              const assetRes = await shopifyFetch(
                `https://${sourceUrl}/admin/api/${version}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`,
                { headers: { "X-Shopify-Access-Token": sourceToken } }
              );

              // Handle 429 rate-limit
              if (assetRes.status === 429) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                continue;
              }

              if (!assetRes.ok) {
                lastResult = { key: asset.key, status: "error", error: `Fetch failed: ${assetRes.status}` };
                continue;
              }

              const assetData = (await assetRes.json()).asset;

              // Prepare asset for PUT
              const putBody = { asset: { key: asset.key } };
              if (assetData.value !== undefined && assetData.value !== null) {
                putBody.asset.value = assetData.value;
              } else if (assetData.attachment) {
                putBody.asset.attachment = assetData.attachment;
              } else if (assetData.public_url) {
                putBody.asset.src = assetData.public_url;
              } else {
                return { key: asset.key, status: "skipped", error: "No content available" };
              }

              // PUT asset to target
              const putRes = await shopifyFetch(
                `https://${targetShop}/admin/api/${version}/themes/${newTheme.id}/assets.json`,
                { method: "PUT", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken }, body: JSON.stringify(putBody) }
              );

              // Handle 429 rate-limit on PUT
              if (putRes.status === 429) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                continue;
              }

              if (putRes.ok) return { key: asset.key, status: "success" };
              const e = await putRes.text().catch(() => "");
              lastResult = { key: asset.key, status: "error", error: e.slice(0, 100) };

            } catch (err) {
              lastResult = { key: asset.key, status: "error", error: err.message };
            }
          }

          // Return last attempt result if all retries failed
          return lastResult || { key: asset.key, status: "error", error: "Unknown error" };
        }));
        results.push(...batchResults);
      }

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

  // ── Save transfer record to DB ──
  if (intent === "save-record") {
    try {
      const summary = JSON.parse(formData.get("summary") || "{}");
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

// Only modules we actually transfer today + a single, clearly-explained
// "protected" row for Customers. Vague coming-soon placeholders have
// been removed — they make the app feel broken.
const MODULES = [
  { key: "collections", label: "Collections & Products", desc: "Custom and smart collections with all linked products", icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z", available: true },
  { key: "products", label: "Standalone Products", desc: "Products not in any collection", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", available: true },
  { key: "themes", label: "Themes", desc: "Copies theme files as an unpublished theme on the destination", icon: "M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42", available: true },
  { key: "customers", label: "Customers", desc: "Customer data contains PII and is protected — not transferable", icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z", protected: true },
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

  const destinationName = formatShopName(currentShop);

  const [step, setStep] = useState(STEP_CONNECT);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [sourceInfo, setSourceInfo] = useState(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [hasSavedConnection, setHasSavedConnection] = useState(!!savedConnection);

  // Scope
  const [scope, setScope] = useState("full"); // "full" | "custom"
  const [selectedModules, setSelectedModules] = useState(new Set(AVAILABLE_KEYS));

  // Configure — seeded from user prefs after mount (SSR-safe)
  const [dryRun, setDryRun] = useState(false);
  const [conflictMode, setConflictMode] = useState("skip");
  const [selectedThemeId, setSelectedThemeId] = useState(null);
  const [themeAction, setThemeAction] = useState("unpublished"); // "unpublished" | "replace"

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

  const isBusy = fetcher.state !== "idle";

  const updateSourceUrl = useCallback((val) => {
    setSourceUrl(val);
    const clean = val.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    credsRef.current.url = clean.includes(".") ? clean : (clean ? clean + ".myshopify.com" : "");
  }, []);
  const updateSourceToken = useCallback((val) => {
    setSourceToken(val);
    credsRef.current.token = val.trim();
  }, []);

  // ── Process connect/verify response ──
  function handleConnectResponse(d) {
    setLoadingMsg("");
    if (d.ok) {
      setSourceInfo({
        shopName: d.shopName, shopEmail: d.shopEmail, shopPlan: d.shopPlan,
        productCount: d.productCount, collectionCount: d.collectionCount,
        themeCount: d.themeCount, themes: d.themes || [],
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
      fetcher.submit(fd, { method: "POST" });
    } else if (moduleKey === "products") {
      setLoadingMsg("Transferring standalone products...");
      const fd = new FormData();
      fd.append("intent", "transfer-products");
      fd.append("skipCollectionProducts", selectedModules.has("collections") ? "true" : "false");
      fd.append("dryRun", String(dryRun));
      fd.append("conflictMode", conflictMode);
      fd.append("rid", nextRid());
      fetcher.submit(fd, { method: "POST" });
    } else if (moduleKey === "themes") {
      if (!selectedThemeId) { advanceModuleQueue(); return; }
      setLoadingMsg("Transferring theme assets...");
      const theme = sourceInfo?.themes?.find((t) => t.id === selectedThemeId);
      const fd = new FormData();
      fd.append("intent", "transfer-theme");
      fd.append("themeId", String(selectedThemeId));
      fd.append("themeName", theme?.name || "Theme");
      fd.append("dryRun", String(dryRun));
      fd.append("rid", nextRid());
      fetcher.submit(fd, { method: "POST" });
    }
  }

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
      if (!d.ok) { setError(d.error); advanceModuleQueue(); return; }
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
      fd.append("rid", nextRid());
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
        fd.append("rid", nextRid());
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

    if (d.intent === "transfer-theme") {
      setLoadingMsg("");
      const updated = { ...transferResultsRef.current, themes: d };
      transferResultsRef.current = updated;
      setTransferResults(updated);
      advanceModuleQueue();
      return;
    }
  }, [fetcher.state, fetcher.data]);

  // ── Elapsed timer while transferring ──
  useEffect(() => {
    if (step !== STEP_TRANSFER) { setTransferElapsed(0); return; }
    const id = setInterval(() => setTransferElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [step]);

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
    saveFetcher.submit(fd, { method: "POST" });
  }

  // ── Actions ──
  const handleConnect = useCallback(() => {
    setError(""); setLoadingMsg("Verifying store connection...");
    const fd = new FormData();
    fd.append("intent", "connect");
    fd.append("sourceUrl", credsRef.current.url);
    fd.append("sourceToken", credsRef.current.token);
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher]);

  const handleReconnect = useCallback(() => {
    setError(""); setLoadingMsg("Verifying saved connection...");
    const fd = new FormData();
    fd.append("intent", "verify-connection");
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher]);

  const handleDisconnect = useCallback(() => {
    const fd = new FormData();
    fd.append("intent", "disconnect");
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher]);

  const handleChangeStore = useCallback(() => {
    setHasSavedConnection(false);
    setSourceInfo(null);
    setSourceUrl("");
    setSourceToken("");
    credsRef.current = { url: "", token: "" };
  }, []);

  const startTransfer = useCallback(() => {
    const modules = [...selectedModules].filter((k) => MODULES.find((m) => m.key === k)?.available);
    if (modules.length === 0) return;

    setStep(STEP_TRANSFER);
    setTransferResults({});
    transferResultsRef.current = {};
    setError("");
    savingRecord.current = false;
    collectionsDataRef.current = [];
    collectionQueueRef.current = [];

    // Build module queue
    moduleQueueRef.current = modules.slice(1);
    startModuleTransfer(modules[0]);
  }, [selectedModules, dryRun, selectedThemeId]);

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
    if (key === "themes" && r.themes?.results) {
      return { total: r.themes.results.length, success: r.themes.results.filter((a) => a.status === "success").length, errors: r.themes.results.filter((a) => a.status === "error").length, dryRun: r.themes.results.filter((a) => a.status === "dry-run").length };
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
    if (moduleKey === "themes" && r.themes?.results) {
      for (const a of r.themes.results.filter((x) => x.status === "error")) {
        rows.push([esc(moduleKey), "asset", esc(a.key), esc(a.error), esc(friendlyError(a.error))].join(","));
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
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }}>Transfer Store</span>
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

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <div>
              <p className="text-sm font-semibold text-red-800">Something went wrong</p>
              <p className="text-sm text-red-700 mt-0.5">{error}</p>
            </div>
          </div>
        )}

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

            {/* New connection form */}
            {(!hasSavedConnection || !savedConnection) && (
              <>
                {/* Instructions toggle */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <button onClick={() => setShowInstructions((p) => !p)} className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-gray-50/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)" }}>
                        <svg className="w-4 h-4" style={{ color: P }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>
                      </div>
                      <span className="text-sm font-semibold text-gray-900">How to get your source store access token</span>
                    </div>
                    <svg className={`w-5 h-5 text-gray-400 transition-transform ${showInstructions ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  {showInstructions && (
                    <div className="px-6 pb-6 border-t border-gray-100">
                      <div className="mt-4 space-y-3">
                        {[
                          ["Open your source store's Shopify Admin", "Go to https://your-store.myshopify.com/admin"],
                          ["Go to Settings \u2192 Apps and sales channels \u2192 Develop apps", "Click Settings in bottom-left, then Apps and sales channels, then Develop apps"],
                          ["Enable custom app development if needed", "Click Allow custom app development and confirm"],
                          ["Create a new app", "Click Create an app, name it (e.g. Store Transfer), then Create app"],
                          ["Configure Admin API scopes", "Check: read_products, read_product_listings, read_collections, read_themes. Then Save"],
                          ["Install the app and copy the token", "Click Install app, then API credentials tab, Reveal token once. Copy it immediately!"],
                          ["Paste it below", "Enter your source store URL and token below"],
                        ].map(([title, desc], i) => (
                          <div key={i} className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: P }}>{i + 1}</span>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{title}</p>
                              <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                            </div>
                          </div>
                        ))}
                        <div className="mt-3 rounded-lg px-4 py-3 bg-amber-50 border border-amber-200">
                          <p className="text-xs text-amber-700">The token starts with <strong>shpat_</strong>. You only need <strong>read</strong> permissions on the source store. Your connection will be saved securely for future visits.</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Connection form */}
                <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 shadow-sm max-w-xl mx-auto">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)" }}>
                      <svg className="w-6 h-6" style={{ color: P }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-gray-900">Connect Source Store</h2>
                      <p className="text-sm text-gray-500">The store you want to copy data <strong>from</strong></p>
                    </div>
                  </div>
                  <div className="rounded-lg px-3 py-2 mb-5 text-[11px]" style={{ background: "rgba(46,99,22,0.06)", color: S }}>
                    The credentials below belong to the <strong>source store</strong>. Data will be copied into your current store (<strong>{destinationName}</strong>).
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Source Store URL</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">https://</span>
                        <input type="text" value={sourceUrl} onChange={(e) => updateSourceUrl(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && sourceUrl.trim() && sourceToken.trim() && handleConnect()}
                          placeholder="my-store.myshopify.com"
                          className="w-full pl-[70px] pr-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent"
                          disabled={isBusy} />
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1">The myshopify domain of the store you&apos;re copying <strong>from</strong> — not this current store.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Source Store Admin API Access Token</label>
                      <input type="password" value={sourceToken} onChange={(e) => updateSourceToken(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && sourceUrl.trim() && sourceToken.trim() && handleConnect()}
                        placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent font-mono"
                        disabled={isBusy} />
                      <p className="text-[11px] text-gray-400 mt-1">Create this token in the source store&apos;s Shopify admin (Settings → Develop apps). Read-only scopes only.</p>
                    </div>
                    <button onClick={handleConnect} disabled={isBusy || !sourceUrl.trim() || !sourceToken.trim()}
                      style={!isBusy && sourceUrl.trim() && sourceToken.trim() ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                      className={`w-full px-5 py-3 text-sm rounded-lg transition-all ${!isBusy && sourceUrl.trim() && sourceToken.trim() ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                    >
                      {isBusy ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                          {loadingMsg || "Connecting..."}
                        </span>
                      ) : "Connect & Continue"}
                    </button>
                  </div>
                  <div className="mt-6 rounded-lg px-4 py-3 flex items-start gap-3" style={{ background: "rgba(23,50,10,0.04)", border: "1px solid rgba(23,50,10,0.1)" }}>
                    <svg className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: S }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>
                    <div>
                      <p className="text-sm font-medium" style={{ color: P }}>Secure connection</p>
                      <p className="text-xs text-gray-500 mt-0.5">Your credentials are encrypted and saved for future visits. Only <strong>read</strong> access is needed. Data is <strong>created as new</strong> — nothing is deleted.</p>
                    </div>
                  </div>
                </div>
              </>
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
                    <label key={mod.key}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${mod.protected ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} ${selectedModules.has(mod.key) && mod.available ? "border-green-200 bg-green-50/30" : "border-gray-200 bg-white"}`}
                    >
                      <input type="checkbox" checked={selectedModules.has(mod.key)} onChange={() => mod.available && toggleModule(mod.key)}
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
            {/* Dry run banner */}
            {dryRun && (
              <div className="rounded-xl px-5 py-4 border-2 border-blue-200 bg-blue-50/50 flex items-center gap-3">
                <svg className="w-5 h-5 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
                <div>
                  <p className="text-sm font-semibold text-blue-800">Dry Run Mode Active</p>
                  <p className="text-xs text-blue-600">No data will be created or modified. This is a simulation only.</p>
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
                  const count = key === "collections" ? sourceInfo?.collectionCount : key === "products" ? sourceInfo?.productCount : key === "themes" ? 1 : "—";
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

              {/* Warnings */}
              {conflictMode === "overwrite" && (
                <div className="mt-4 rounded-lg px-4 py-3 bg-amber-50 border border-amber-200">
                  <p className="text-xs font-semibold text-amber-800">Warning: Overwrite mode</p>
                  <p className="text-xs text-amber-700 mt-0.5">Existing products and collections with matching handles may be overwritten. This cannot be undone.</p>
                </div>
              )}

              {selectedModules.has("themes") && (
                <div className="mt-4 rounded-lg px-4 py-3 bg-blue-50 border border-blue-200">
                  <p className="text-xs text-blue-700">Theme will be transferred as <strong>unpublished</strong>. Review it before publishing.</p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_CONFIGURE)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={startTransfer}
                style={{ background: dryRun ? "#2563eb" : P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]"
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
                    const pct = activeModules.length > 0 ? Math.round((completedCount / activeModules.length) * 100) : 0;
                    return (
                      <div className="mt-3 w-full">
                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                          <span>{completedCount} / {activeModules.length} modules complete</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1.5">
                          <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: P }} />
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
            {dryRun ? (
              <div className="rounded-xl px-5 py-4 border-2 border-blue-200 bg-blue-50/50 flex items-center gap-3">
                <svg className="w-5 h-5 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>
                <p className="text-sm font-semibold text-blue-800">Dry Run Results — No data was modified in {destinationName}</p>
              </div>
            ) : (
              <div className="rounded-xl px-5 py-4 border-2 flex items-center gap-3" style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }}>
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
            )}

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
                      <p className="text-2xl font-bold text-gray-900">{activeModules.length}</p>
                      <p className="text-sm text-gray-600 font-medium">Modules</p>
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

                  {key === "themes" && transferResults.themes && (
                    <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60">
                      {transferResults.themes.ok && transferResults.themes.newThemeId ? (
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
                            <a href={`https://${currentShop}/admin/themes`} target="_top" rel="noopener noreferrer"
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white whitespace-nowrap text-center" style={{ background: S }}>
                              View in Admin
                            </a>
                            {transferResults.themes?.previewUrl && (
                              <a href={transferResults.themes.previewUrl} target="_top" rel="noopener noreferrer"
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap text-center border" style={{ color: S, borderColor: "rgba(46,99,22,0.3)" }}>
                                Preview Theme
                              </a>
                            )}
                          </div>
                          </div>
                          <p className="text-[11px] text-gray-500">
                            Asset copy: {stats.success} succeeded{stats.errors > 0 ? `, ${stats.errors} failed` : ""}. Failed assets are typically binary files whose source URL isn&apos;t accessible — the rest of the theme is still usable.
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs text-red-600">
                          Theme creation failed on the destination store: {friendlyError(transferResults.themes.error)}
                        </p>
                      )}

                      {stats.errors > 0 && (
                        <details className="mt-3">
                          <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-700">Show failing assets ({stats.errors})</summary>
                          <div className="mt-2 divide-y divide-gray-100 max-h-[200px] overflow-auto bg-white rounded-lg border border-gray-100">
                            {transferResults.themes.results.filter((a) => a.status === "error").slice(0, 50).map((a, i) => (
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
              <a href="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back to Dashboard</a>
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
