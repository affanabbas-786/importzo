import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";

// ═══════════════════════════════════════════════════════════════════
// Server actions — each intent is self-contained
// ═══════════════════════════════════════════════════════════════════
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetShop = session.shop;
  const targetToken = session.accessToken;
  const version = apiVersion || "2025-10";
  const rid = formData.get("rid") || "";

  // Helper: paginated REST fetch from any Shopify store
  async function fetchAllPages(baseUrl, token) {
    const items = [];
    let url = baseUrl;
    while (url) {
      const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      });
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

  // ── 1. Connect & verify source store ──
  if (intent === "connect") {
    let sourceUrl = (formData.get("sourceUrl") || "").trim();
    sourceUrl = sourceUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const sourceToken = (formData.get("sourceToken") || "").trim();

    if (!sourceUrl) return { intent: "connect", rid, ok: false, error: "Please enter your source store URL (e.g. my-store.myshopify.com)" };
    if (!sourceToken) return { intent: "connect", rid, ok: false, error: "Please enter the Admin API access token from your source store" };

    // Normalize: ensure it ends with .myshopify.com
    if (!sourceUrl.includes(".")) {
      sourceUrl = sourceUrl + ".myshopify.com";
    }

    try {
      const res = await fetch(`https://${sourceUrl}/admin/api/${version}/shop.json`, {
        headers: { "X-Shopify-Access-Token": sourceToken },
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid access token. Make sure you copied the full token starting with shpat_");
      }
      if (res.status === 404) {
        throw new Error("Store not found. Check the URL — it should be like my-store.myshopify.com");
      }
      if (!res.ok) {
        throw new Error(`Connection failed (HTTP ${res.status}). Check URL and token.`);
      }
      const data = await res.json();
      const shopName = data.shop?.name || sourceUrl;
      const shopEmail = data.shop?.email || "";
      const shopPlan = data.shop?.plan_display_name || "";

      // Also fetch product count + collection count for display
      let productCount = 0;
      let collectionCount = 0;
      try {
        const pc = await fetch(`https://${sourceUrl}/admin/api/${version}/products/count.json`, {
          headers: { "X-Shopify-Access-Token": sourceToken },
        });
        if (pc.ok) { const d = await pc.json(); productCount = d.count || 0; }
      } catch (_) { /* non-critical */ }
      try {
        const cc1 = await fetch(`https://${sourceUrl}/admin/api/${version}/custom_collections/count.json`, {
          headers: { "X-Shopify-Access-Token": sourceToken },
        });
        const cc2 = await fetch(`https://${sourceUrl}/admin/api/${version}/smart_collections/count.json`, {
          headers: { "X-Shopify-Access-Token": sourceToken },
        });
        if (cc1.ok) { const d = await cc1.json(); collectionCount += d.count || 0; }
        if (cc2.ok) { const d = await cc2.json(); collectionCount += d.count || 0; }
      } catch (_) { /* non-critical */ }

      return {
        intent: "connect", rid, ok: true,
        shopName, shopEmail, shopPlan, shopDomain: sourceUrl,
        productCount, collectionCount,
      };
    } catch (err) {
      return { intent: "connect", rid, ok: false, error: err.message };
    }
  }

  // ── 2. Fetch all collections from source ──
  if (intent === "fetch-collections") {
    const sourceUrl = formData.get("sourceUrl");
    const sourceToken = formData.get("sourceToken");
    try {
      const custom = await fetchAllPages(
        `https://${sourceUrl}/admin/api/${version}/custom_collections.json?limit=250`,
        sourceToken,
      );
      const smart = await fetchAllPages(
        `https://${sourceUrl}/admin/api/${version}/smart_collections.json?limit=250`,
        sourceToken,
      );

      const collections = [];

      for (const c of custom) {
        let productCount = 0;
        try {
          const r = await fetch(`https://${sourceUrl}/admin/api/${version}/products/count.json?collection_id=${c.id}`, {
            headers: { "X-Shopify-Access-Token": sourceToken },
          });
          if (r.ok) productCount = (await r.json()).count || 0;
        } catch (_) { /* skip */ }
        collections.push({
          id: c.id, title: c.title, handle: c.handle, body_html: c.body_html || "",
          image: c.image?.src || "", published: !!c.published_at, sort_order: c.sort_order || "",
          type: "custom", productCount,
        });
      }

      for (const c of smart) {
        let productCount = 0;
        try {
          const r = await fetch(`https://${sourceUrl}/admin/api/${version}/products/count.json?collection_id=${c.id}`, {
            headers: { "X-Shopify-Access-Token": sourceToken },
          });
          if (r.ok) productCount = (await r.json()).count || 0;
        } catch (_) { /* skip */ }
        collections.push({
          id: c.id, title: c.title, handle: c.handle, body_html: c.body_html || "",
          image: c.image?.src || "", published: !!c.published_at, sort_order: c.sort_order || "",
          type: "smart", rules: c.rules || [], disjunctive: c.disjunctive || false, productCount,
        });
      }

      return { intent: "fetch-collections", rid, ok: true, collections };
    } catch (err) {
      return { intent: "fetch-collections", rid, ok: false, error: err.message };
    }
  }

  // ── 3. Fetch products for selected collections (preview) ──
  if (intent === "fetch-preview") {
    const sourceUrl = formData.get("sourceUrl");
    const sourceToken = formData.get("sourceToken");
    const collectionIds = JSON.parse(formData.get("collectionIds") || "[]");
    try {
      const result = {};
      for (const colId of collectionIds) {
        const products = await fetchAllPages(
          `https://${sourceUrl}/admin/api/${version}/collections/${colId}/products.json?limit=250`,
          sourceToken,
        );
        result[colId] = products.map((p) => ({
          id: p.id,
          title: p.title,
          handle: p.handle,
          variantCount: (p.variants || []).length,
          imageCount: (p.images || []).length,
          image: p.image?.src || (p.images?.[0]?.src) || "",
        }));
      }
      return { intent: "fetch-preview", rid, ok: true, collectionProducts: result };
    } catch (err) {
      return { intent: "fetch-preview", rid, ok: false, error: err.message };
    }
  }

  // ── 4. Transfer ONE collection with ALL its products ──
  if (intent === "transfer") {
    const sourceUrl = formData.get("sourceUrl");
    const sourceToken = formData.get("sourceToken");
    const col = JSON.parse(formData.get("collection"));

    const out = {
      collectionId: col.id,
      collectionTitle: col.title,
      collectionType: col.type,
      newCollectionId: null,
      collectionWarning: null,
      collectionError: null,
      products: [],
    };

    try {
      // Step A: Create collection in target store
      let newColId = null;

      if (col.type === "smart") {
        const body = {
          smart_collection: {
            title: col.title,
            body_html: col.body_html || "",
            published: col.published,
            sort_order: col.sort_order || "alpha-asc",
            rules: col.rules && col.rules.length > 0
              ? col.rules
              : [{ column: "tag", relation: "equals", condition: col.title || "imported" }],
            disjunctive: col.disjunctive || false,
          },
        };
        if (col.image) body.smart_collection.image = { src: col.image };

        let res = await fetch(`https://${targetShop}/admin/api/${version}/smart_collections.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
          body: JSON.stringify(body),
        });

        // Retry without image on failure
        if (!res.ok && col.image) {
          delete body.smart_collection.image;
          out.collectionWarning = "Collection image could not be imported — skipped";
          res = await fetch(`https://${targetShop}/admin/api/${version}/smart_collections.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
            body: JSON.stringify(body),
          });
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`);
        }
        newColId = (await res.json()).smart_collection.id;
      } else {
        // Custom collection
        const body = {
          custom_collection: {
            title: col.title,
            body_html: col.body_html || "",
            published: col.published,
            sort_order: col.sort_order || "",
          },
        };
        if (col.image) body.custom_collection.image = { src: col.image };

        let res = await fetch(`https://${targetShop}/admin/api/${version}/custom_collections.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
          body: JSON.stringify(body),
        });

        if (!res.ok && col.image) {
          delete body.custom_collection.image;
          out.collectionWarning = "Collection image could not be imported — skipped";
          res = await fetch(`https://${targetShop}/admin/api/${version}/custom_collections.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
            body: JSON.stringify(body),
          });
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`);
        }
        newColId = (await res.json()).custom_collection.id;
      }

      out.newCollectionId = newColId;

      // Step B: Fetch all products in this collection from source
      const sourceProducts = await fetchAllPages(
        `https://${sourceUrl}/admin/api/${version}/collections/${col.id}/products.json?limit=250`,
        sourceToken,
      );

      // Step C: Create each product in target + link to collection
      for (const src of sourceProducts) {
        const pr = { sourceId: src.id, title: src.title, status: "success", error: null, warnings: [] };
        try {
          const pd = {
            title: src.title || "Untitled",
            body_html: src.body_html || "",
            vendor: src.vendor || "",
            product_type: src.product_type || "",
            tags: src.tags || "",
            handle: src.handle || "",
            published: !!src.published_at,
          };

          if (src.options?.length > 0) {
            pd.options = src.options.map((o) => ({ name: o.name }));
          }

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

          // Images — only valid URLs
          const validImages = (src.images || [])
            .filter((img) => img.src && /^https?:\/\//i.test(img.src))
            .slice(0, 250)
            .map((img) => ({ src: img.src }));
          if (validImages.length > 0) pd.images = validImages;

          let createRes = await fetch(`https://${targetShop}/admin/api/${version}/products.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
            body: JSON.stringify({ product: pd }),
          });

          // If fail with images → retry without
          if (!createRes.ok && pd.images) {
            pr.warnings.push("Images failed — product created without images");
            delete pd.images;
            createRes = await fetch(`https://${targetShop}/admin/api/${version}/products.json`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
              body: JSON.stringify({ product: pd }),
            });
          }

          if (!createRes.ok) {
            const err = await createRes.json().catch(() => ({}));
            throw new Error(err.errors ? JSON.stringify(err.errors) : `HTTP ${createRes.status}`);
          }

          const created = (await createRes.json()).product;
          pr.newProductId = created.id;

          // Link to custom collection via collects
          if (col.type !== "smart" && newColId) {
            try {
              const collectRes = await fetch(`https://${targetShop}/admin/api/${version}/collects.json`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
                body: JSON.stringify({ collect: { product_id: created.id, collection_id: newColId } }),
              });
              if (!collectRes.ok) pr.warnings.push("Product created but could not link to collection");
            } catch (_) {
              pr.warnings.push("Product created but collection link failed");
            }
          }
        } catch (err) {
          pr.status = "error";
          pr.error = err.message;
        }
        out.products.push(pr);
      }
    } catch (err) {
      out.collectionError = err.message;
    }

    return { intent: "transfer", rid, ok: true, result: out };
  }

  // ── 5. Save transfer record to DB ──
  if (intent === "save-record") {
    const summary = JSON.parse(formData.get("summary") || "{}");
    await prisma.importJob.create({
      data: {
        shop: session.shop,
        fileName: `store_transfer_${summary.collections || 0}_collections`,
        totalRows: summary.totalProducts || 0,
        successCount: summary.successProducts || 0,
        errorCount: summary.errorProducts || 0,
        status: (summary.errorProducts || 0) === 0 ? "completed" : (summary.successProducts || 0) === 0 ? "failed" : "completed_with_errors",
        results: formData.get("results") || "[]",
        importType: "collections",
      },
    });
    return { intent: "save-record", rid, ok: true };
  }

  return { intent, rid, ok: false, error: "Unknown action" };
};

// ═══════════════════════════════════════════════════════════════════
// Client component
// ═══════════════════════════════════════════════════════════════════
const STEP_CONNECT = 0;
const STEP_SELECT = 1;
const STEP_PREVIEW = 2;
const STEP_TRANSFER = 3;
const STEP_RESULTS = 4;

let _rid = 0;
function nextRid() { return String(++_rid); }

export default function StoreTransferPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  // ── State ──
  const [step, setStep] = useState(STEP_CONNECT);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [sourceInfo, setSourceInfo] = useState(null); // { shopName, shopEmail, shopPlan, productCount, collectionCount }
  const [collections, setCollections] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [previewData, setPreviewData] = useState({}); // { colId: [products] }
  const [transferResults, setTransferResults] = useState([]);
  const [progress, setProgress] = useState({ idx: 0, total: 0, name: "" });
  const [error, setError] = useState("");
  const [loadingMsg, setLoadingMsg] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [recordSaved, setRecordSaved] = useState(false);

  // ── Refs: freeze credentials at transfer start, track processed responses ──
  const frozenCreds = useRef({ url: "", token: "" });
  const transferQueueRef = useRef([]);
  const lastRid = useRef("");
  const isTransferring = useRef(false);

  const isBusy = fetcher.state !== "idle";
  const primary = "#17320A";
  const secondary = "#2E6316";
  const font = "'ImportzoFont', sans-serif";

  // ═══ Fetcher response handler — uses rid to avoid re-processing ═══
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const d = fetcher.data;
    if (!d.rid || d.rid === lastRid.current) return; // skip already-processed
    lastRid.current = d.rid;

    if (d.intent === "connect") {
      setLoadingMsg("");
      if (d.ok) {
        setSourceInfo({ shopName: d.shopName, shopEmail: d.shopEmail, shopPlan: d.shopPlan, productCount: d.productCount, collectionCount: d.collectionCount });
        setError("");
        shopify.toast.show(`Connected to ${d.shopName}`);
        // Freeze credentials and fetch collections
        const cleanUrl = sourceUrl.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
        const cleanUrlNorm = cleanUrl.includes(".") ? cleanUrl : cleanUrl + ".myshopify.com";
        frozenCreds.current = { url: cleanUrlNorm, token: sourceToken.trim() };
        setLoadingMsg("Fetching collections...");
        const fd = new FormData();
        fd.append("intent", "fetch-collections");
        fd.append("sourceUrl", frozenCreds.current.url);
        fd.append("sourceToken", frozenCreds.current.token);
        fd.append("rid", nextRid());
        fetcher.submit(fd, { method: "POST" });
      } else {
        setError(d.error || "Connection failed");
      }
    }

    if (d.intent === "fetch-collections") {
      setLoadingMsg("");
      if (d.ok) {
        setCollections(d.collections);
        setStep(STEP_SELECT);
        shopify.toast.show(`Found ${d.collections.length} collections`);
      } else {
        setError(d.error || "Failed to fetch collections");
      }
    }

    if (d.intent === "fetch-preview") {
      setLoadingMsg("");
      if (d.ok) {
        setPreviewData(d.collectionProducts);
        setStep(STEP_PREVIEW);
      } else {
        setError(d.error || "Failed to load preview");
      }
    }

    if (d.intent === "transfer") {
      if (d.ok && d.result) {
        setTransferResults((prev) => [...prev, d.result]);
      }
      // Process next in queue
      if (transferQueueRef.current.length > 0) {
        const next = transferQueueRef.current.shift();
        setProgress({ idx: next.idx, total: next.total, name: next.col.title });
        const fd = new FormData();
        fd.append("intent", "transfer");
        fd.append("sourceUrl", frozenCreds.current.url);
        fd.append("sourceToken", frozenCreds.current.token);
        fd.append("collection", JSON.stringify(next.col));
        fd.append("rid", nextRid());
        fetcher.submit(fd, { method: "POST" });
      } else {
        // All done
        isTransferring.current = false;
        setStep(STEP_RESULTS);
        shopify.toast.show("Transfer complete!");
      }
    }

    if (d.intent === "save-record") {
      setRecordSaved(true);
    }
  }, [fetcher.state, fetcher.data]);

  // ═══ Save record once results are shown ═══
  useEffect(() => {
    if (step !== STEP_RESULTS || transferResults.length === 0 || recordSaved) return;
    const totalProducts = transferResults.reduce((s, r) => s + r.products.length, 0);
    const successProducts = transferResults.reduce((s, r) => s + r.products.filter((p) => p.status === "success").length, 0);
    const errorProducts = totalProducts - successProducts;
    const fd = new FormData();
    fd.append("intent", "save-record");
    fd.append("summary", JSON.stringify({ collections: transferResults.length, totalProducts, successProducts, errorProducts }));
    fd.append("results", JSON.stringify(transferResults));
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [step, transferResults, recordSaved]);

  // ── Actions ──
  const handleConnect = useCallback(() => {
    setError("");
    setLoadingMsg("Verifying store connection...");
    const fd = new FormData();
    fd.append("intent", "connect");
    fd.append("sourceUrl", sourceUrl);
    fd.append("sourceToken", sourceToken);
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [sourceUrl, sourceToken, fetcher]);

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selected.size === collections.length) setSelected(new Set());
    else setSelected(new Set(collections.map((c) => c.id)));
  }, [selected, collections]);

  const handlePreview = useCallback(() => {
    setError("");
    setLoadingMsg("Loading products for preview...");
    const fd = new FormData();
    fd.append("intent", "fetch-preview");
    fd.append("sourceUrl", frozenCreds.current.url);
    fd.append("sourceToken", frozenCreds.current.token);
    fd.append("collectionIds", JSON.stringify([...selected]));
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [selected, fetcher]);

  const startTransfer = useCallback(() => {
    const selectedCols = collections.filter((c) => selected.has(c.id));
    if (selectedCols.length === 0) return;

    setStep(STEP_TRANSFER);
    setTransferResults([]);
    setError("");
    setRecordSaved(false);
    isTransferring.current = true;

    // Build queue (skip first — we submit it immediately)
    const total = selectedCols.length;
    transferQueueRef.current = selectedCols.slice(1).map((col, i) => ({ col, idx: i + 2, total }));

    // Submit first collection immediately
    const first = selectedCols[0];
    setProgress({ idx: 1, total, name: first.title });
    const fd = new FormData();
    fd.append("intent", "transfer");
    fd.append("sourceUrl", frozenCreds.current.url);
    fd.append("sourceToken", frozenCreds.current.token);
    fd.append("collection", JSON.stringify(first));
    fd.append("rid", nextRid());
    fetcher.submit(fd, { method: "POST" });
  }, [collections, selected, fetcher]);

  const resetAll = useCallback(() => {
    setStep(STEP_CONNECT);
    setSourceUrl("");
    setSourceToken("");
    setSourceInfo(null);
    setCollections([]);
    setSelected(new Set());
    setPreviewData({});
    setTransferResults([]);
    setProgress({ idx: 0, total: 0, name: "" });
    setError("");
    setLoadingMsg("");
    setRecordSaved(false);
    frozenCreds.current = { url: "", token: "" };
    transferQueueRef.current = [];
    isTransferring.current = false;
  }, []);

  // ── Computed ──
  const selectedCols = collections.filter((c) => selected.has(c.id));
  const totalSelectedProducts = selectedCols.reduce((s, c) => s + c.productCount, 0);
  const previewProducts = Object.values(previewData).reduce((s, arr) => s + arr.length, 0);
  const previewImages = Object.values(previewData).reduce((s, arr) => s + arr.reduce((a, p) => a + p.imageCount, 0), 0);
  const resultSuccess = transferResults.reduce((s, r) => s + r.products.filter((p) => p.status === "success").length, 0);
  const resultErrors = transferResults.reduce((s, r) => s + r.products.filter((p) => p.status === "error").length, 0);
  const resultTotal = transferResults.reduce((s, r) => s + r.products.length, 0);
  const progressPct = step === STEP_TRANSFER && progress.total > 0
    ? Math.round(((progress.idx - 1 + (isBusy ? 0.5 : 1)) / progress.total) * 100)
    : step === STEP_RESULTS ? 100 : 0;

  // ═══════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════
  return (
    <s-page
      heading="Store Transfer"
      subtitle={["Connect", "Select", "Preview", "Transferring", "Results"][step]}
      backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}
    >
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: primary, fontFamily: font }}>Store Transfer</span>
        </div>

        {/* Step Indicator */}
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between max-w-2xl mx-auto">
            {["Connect", "Select", "Preview", "Transfer", "Results"].map((label, i) => (
              <div key={label} className="flex items-center flex-1 last:flex-initial">
                <div className="flex flex-col items-center gap-1.5">
                  <div style={{
                    width: 36, height: 36, minWidth: 36, minHeight: 36, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600,
                    ...(i < step
                      ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" }
                      : i === step
                        ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" }
                        : { background: "#E5E7EB", color: "#6b7280" }),
                  }}>
                    {i < step ? (
                      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    ) : i + 1}
                  </div>
                  <span className={`text-xs font-medium hidden sm:block ${i <= step ? "text-gray-900" : "text-gray-400"}`}>{label}</span>
                </div>
                {i < 4 && <div style={{ flex: 1, height: 2, marginLeft: 12, marginRight: 12, borderRadius: 1, background: i < step ? primary : "#e5e7eb" }} />}
              </div>
            ))}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-red-800">Something went wrong</p>
              <p className="text-sm text-red-700 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* ═══════════ STEP 0: CONNECT ═══════════ */}
        {step === STEP_CONNECT && (
          <div className="animate-fade-in space-y-5">
            {/* Instructions toggle */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <button
                onClick={() => setShowInstructions((p) => !p)}
                className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-gray-50/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)" }}>
                    <svg className="w-4 h-4" style={{ color: primary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold text-gray-900">How to get your source store access token (Step-by-step guide)</span>
                </div>
                <svg className={`w-5 h-5 text-gray-400 transition-transform ${showInstructions ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showInstructions && (
                <div className="px-6 pb-6 border-t border-gray-100">
                  <div className="mt-4 space-y-4">
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>1</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Open your source store's Shopify Admin</p>
                        <p className="text-xs text-gray-500 mt-0.5">Go to <strong>https://your-store.myshopify.com/admin</strong> — this is the store you want to copy data FROM</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>2</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Go to Settings → Apps and sales channels → Develop apps</p>
                        <p className="text-xs text-gray-500 mt-0.5">Click <strong>"Settings"</strong> in the bottom-left corner, then <strong>"Apps and sales channels"</strong>, then click <strong>"Develop apps"</strong> at the top</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>3</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Enable custom app development (if not already done)</p>
                        <p className="text-xs text-gray-500 mt-0.5">If you see <strong>"Allow custom app development"</strong>, click it and confirm. This only needs to be done once.</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>4</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Create a new app</p>
                        <p className="text-xs text-gray-500 mt-0.5">Click <strong>"Create an app"</strong>, name it anything (e.g. "Store Transfer"), then click <strong>"Create app"</strong></p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>5</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Configure Admin API scopes</p>
                        <p className="text-xs text-gray-500 mt-0.5">Click <strong>"Configure Admin API scopes"</strong>. Check these boxes: <strong>read_products</strong>, <strong>read_product_listings</strong>, <strong>read_collections</strong>. Then click <strong>"Save"</strong></p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>6</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Install the app and copy the token</p>
                        <p className="text-xs text-gray-500 mt-0.5">Click <strong>"Install app"</strong> and confirm. Then go to the <strong>"API credentials"</strong> tab. Under <strong>"Admin API access token"</strong>, click <strong>"Reveal token once"</strong>. <span className="text-red-600 font-medium">Copy it immediately — you can only see it once!</span></p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: primary }}>7</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">Paste it below</p>
                        <p className="text-xs text-gray-500 mt-0.5">Enter your source store URL and paste the access token below, then click Connect.</p>
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg px-4 py-3 bg-amber-50 border border-amber-200">
                      <div className="flex items-start gap-2">
                        <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <div>
                          <p className="text-xs font-semibold text-amber-800">Important notes</p>
                          <ul className="text-xs text-amber-700 mt-1 space-y-0.5 list-disc list-inside">
                            <li>The token starts with <strong>shpat_</strong> and is about 40 characters long</li>
                            <li>You only need <strong>read</strong> permissions on the source store</li>
                            <li>Your credentials are used in this session only and are never saved</li>
                            <li>Products will be <strong>created as new</strong> in your current store — no data is deleted</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Connection form */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 shadow-sm max-w-xl mx-auto">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)" }}>
                  <svg className="w-6 h-6" style={{ color: primary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Connect Source Store</h2>
                  <p className="text-sm text-gray-500">Enter the store you want to copy collections and products from</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Source Store URL</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">https://</span>
                    <input
                      type="text"
                      value={sourceUrl}
                      onChange={(e) => setSourceUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sourceUrl.trim() && sourceToken.trim() && handleConnect()}
                      placeholder="my-store.myshopify.com"
                      className="w-full pl-[70px] pr-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent"
                      style={{ "--tw-ring-color": "rgba(23,50,10,0.2)" }}
                      disabled={isBusy}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Example: my-store.myshopify.com or just my-store</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Admin API Access Token</label>
                  <input
                    type="password"
                    value={sourceToken}
                    onChange={(e) => setSourceToken(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sourceUrl.trim() && sourceToken.trim() && handleConnect()}
                    placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:border-transparent font-mono"
                    disabled={isBusy}
                  />
                  <p className="text-xs text-gray-400 mt-1">Found in source store → Settings → Apps → Develop apps → Your app → API credentials</p>
                </div>

                <button
                  onClick={handleConnect}
                  disabled={isBusy || !sourceUrl.trim() || !sourceToken.trim()}
                  style={!isBusy && sourceUrl.trim() && sourceToken.trim() ? { background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: font } : { borderRadius: 8 }}
                  className={`w-full px-5 py-3 text-sm rounded-lg transition-all ${!isBusy && sourceUrl.trim() && sourceToken.trim() ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                >
                  {isBusy ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                      {loadingMsg || "Connecting..."}
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                      </svg>
                      Connect &amp; Fetch Collections
                    </span>
                  )}
                </button>
              </div>

              <div className="mt-6 rounded-lg px-4 py-3 flex items-start gap-3" style={{ background: "rgba(23,50,10,0.04)", border: "1px solid rgba(23,50,10,0.1)" }}>
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: secondary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
                <div>
                  <p className="text-sm font-medium" style={{ color: primary }}>Your data is safe</p>
                  <p className="text-xs text-gray-500 mt-0.5">Credentials are used for this session only and never stored. Only <strong>read</strong> access is needed on the source store. Products are <strong>created as new</strong> in your current store — nothing is deleted or overwritten.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ STEP 1: SELECT COLLECTIONS ═══════════ */}
        {step === STEP_SELECT && (
          <div className="animate-fade-in space-y-4">
            {/* Source store info card */}
            {sourceInfo && (
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm flex items-center gap-4 flex-wrap">
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-green-50">
                  <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">Connected to {sourceInfo.shopName}</p>
                  <p className="text-xs text-gray-500">{sourceInfo.collectionCount} collections · {sourceInfo.productCount} products{sourceInfo.shopPlan ? ` · ${sourceInfo.shopPlan}` : ""}</p>
                </div>
                <button onClick={() => { resetAll(); }} className="text-xs font-medium text-gray-500 hover:text-gray-700 px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">Disconnect</button>
              </div>
            )}

            {/* Collection list */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Select Collections to Transfer</h2>
                  <p className="text-sm text-gray-500 mt-0.5">{collections.length} collection{collections.length !== 1 ? "s" : ""} available · {selected.size} selected</p>
                </div>
                <button onClick={toggleAll} className="text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors" style={{ color: primary }}>
                  {selected.size === collections.length ? "Deselect All" : "Select All"}
                </button>
              </div>

              <div className="overflow-auto max-h-[480px]">
                {collections.length === 0 ? (
                  <div className="p-12 text-center">
                    <div className="w-14 h-14 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-3">
                      <svg className="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75" /></svg>
                    </div>
                    <p className="text-sm text-gray-500">No collections found in the source store.</p>
                    <p className="text-xs text-gray-400 mt-1">Make sure the source store has collections and your API token has read_product_listings scope.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {collections.map((col) => (
                      <label key={col.id} className={`flex items-center gap-4 px-6 py-3.5 cursor-pointer transition-colors hover:bg-gray-50/50 ${selected.has(col.id) ? "bg-green-50/30" : ""}`}>
                        <input type="checkbox" checked={selected.has(col.id)} onChange={() => toggleSelect(col.id)} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" style={{ accentColor: primary }} />
                        {col.image ? (
                          <img src={col.image} alt="" className="w-10 h-10 rounded-lg object-cover border border-gray-200 flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                            <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{col.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${col.type === "smart" ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"}`}>{col.type === "smart" ? "Smart" : "Custom"}</span>
                            <span className="text-xs text-gray-400">{col.productCount} product{col.productCount !== 1 ? "s" : ""}</span>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Selected summary */}
            {selected.size > 0 && (
              <div className="rounded-lg px-4 py-3 flex items-center gap-3" style={{ background: "rgba(23,50,10,0.04)", border: "1px solid rgba(23,50,10,0.12)" }}>
                <svg className="w-5 h-5 flex-shrink-0" style={{ color: secondary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
                <p className="text-sm text-gray-700">
                  <strong>{selected.size}</strong> collection{selected.size !== 1 ? "s" : ""} selected with approximately <strong>{totalSelectedProducts}</strong> product{totalSelectedProducts !== 1 ? "s" : ""}
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button onClick={resetAll} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Disconnect</button>
              <button
                onClick={handlePreview}
                disabled={selected.size === 0 || isBusy}
                style={selected.size > 0 && !isBusy ? { background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: font } : { borderRadius: 8 }}
                className={`px-5 py-2.5 text-sm rounded-lg transition-all ${selected.size > 0 && !isBusy ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
              >
                {isBusy ? (
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                    {loadingMsg || "Loading..."}
                  </span>
                ) : `Preview ${selected.size} Collection${selected.size !== 1 ? "s" : ""}`}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════ STEP 2: PREVIEW ═══════════ */}
        {step === STEP_PREVIEW && (
          <div className="animate-fade-in space-y-4">
            {/* Totals */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { label: "Collections", value: selectedCols.length, icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z", bg: "rgba(23,50,10,0.08)", color: primary },
                { label: "Products", value: previewProducts, icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", bg: "rgb(239 246 255)", color: "#3b82f6" },
                { label: "Images", value: previewImages, icon: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z", bg: "rgb(250 245 255)", color: "#a855f7" },
              ].map((s) => (
                <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: s.bg }}>
                      <svg className="w-5 h-5" style={{ color: s.color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={s.icon} /></svg>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gray-900">{s.value}</p>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{s.label}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Per-collection breakdown */}
            {selectedCols.map((col) => {
              const products = previewData[col.id] || [];
              return (
                <div key={col.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
                    {col.image ? (
                      <img src={col.image} alt="" className="w-10 h-10 rounded-lg object-cover border border-gray-200" />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                        <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75" /></svg>
                      </div>
                    )}
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">{col.title}</h3>
                      <p className="text-xs text-gray-500">{products.length} product{products.length !== 1 ? "s" : ""} · {col.type} collection</p>
                    </div>
                  </div>
                  {products.length > 0 && (
                    <div className="overflow-auto max-h-[250px]">
                      <table className="w-full">
                        <thead><tr className="bg-gray-50/80">
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500 uppercase">#</th>
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Product</th>
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Variants</th>
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Images</th>
                        </tr></thead>
                        <tbody className="divide-y divide-gray-100">
                          {products.map((p, i) => (
                            <tr key={p.id} className="hover:bg-gray-50/50">
                              <td className="px-6 py-2.5 text-sm text-gray-400 font-mono">{i + 1}</td>
                              <td className="px-6 py-2.5">
                                <div className="flex items-center gap-2.5">
                                  {p.image ? <img src={p.image} alt="" className="w-8 h-8 rounded object-cover border border-gray-200" /> : <div className="w-8 h-8 rounded bg-gray-100" />}
                                  <span className="text-sm font-medium text-gray-900 truncate max-w-[220px]">{p.title}</span>
                                </div>
                              </td>
                              <td className="px-6 py-2.5 text-sm text-gray-600">{p.variantCount}</td>
                              <td className="px-6 py-2.5 text-sm text-gray-600">{p.imageCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => setStep(STEP_SELECT)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button
                onClick={startTransfer}
                style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: font }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]"
              >
                Start Transfer — {selectedCols.length} Collection{selectedCols.length !== 1 ? "s" : ""}, {previewProducts} Product{previewProducts !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════ STEP 3: TRANSFER PROGRESS ═══════════ */}
        {step === STEP_TRANSFER && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-8 sm:p-10 shadow-sm max-w-2xl mx-auto">
              <div className="flex flex-col items-center gap-6">
                <div style={{ width: 64, height: 64, borderRadius: "50%" }} className="flex items-center justify-center bg-green-50">
                  <svg width="32" height="32" className="animate-spin" style={{ color: primary }} fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>

                <div className="text-center w-full">
                  <h3 className="text-lg font-semibold text-gray-900">Transferring store data...</h3>
                  <p className="text-sm text-gray-500 mt-1">Do not close this page. This may take several minutes for large stores.</p>

                  {/* Progress bar */}
                  <div className="mt-6 w-full">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">
                        Collection {progress.idx} of {progress.total}
                      </span>
                      <span className="text-sm font-bold" style={{ color: primary }}>{progressPct}%</span>
                    </div>
                    <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${progressPct}%`, background: `linear-gradient(90deg, ${primary}, ${secondary})` }} />
                    </div>
                  </div>

                  {/* Current collection */}
                  <div className="mt-4 py-3 px-4 rounded-lg" style={{ background: "rgba(23,50,10,0.04)" }}>
                    <p className="text-sm font-medium" style={{ color: primary }}>
                      Transferring: <strong>{progress.name}</strong>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">Creating collection, importing products with all variants and images...</p>
                  </div>

                  {/* Completed log */}
                  {transferResults.length > 0 && (
                    <div className="mt-5 text-left w-full">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Completed ({transferResults.length})</p>
                      <div className="space-y-1.5 max-h-[200px] overflow-auto">
                        {transferResults.map((r, i) => {
                          const ok = r.products.filter((p) => p.status === "success").length;
                          const err = r.products.filter((p) => p.status === "error").length;
                          return (
                            <div key={i} className="flex items-center gap-2 text-sm py-1">
                              {r.collectionError ? (
                                <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              ) : (
                                <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                              )}
                              <span className="text-gray-700 truncate flex-1">{r.collectionTitle}</span>
                              <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
                                {r.collectionError ? "Failed" : `${ok} product${ok !== 1 ? "s" : ""}${err > 0 ? `, ${err} failed` : ""}`}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ STEP 4: RESULTS ═══════════ */}
        {step === STEP_RESULTS && (
          <div className="animate-fade-in space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-xl border border-green-200 p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
                    <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{transferResults.filter((r) => !r.collectionError).length}</p>
                    <p className="text-sm text-green-600 font-medium">Collections Transferred</p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-green-200 p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center">
                    <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{resultSuccess}</p>
                    <p className="text-sm text-green-600 font-medium">Products Transferred</p>
                  </div>
                </div>
              </div>
              {resultErrors > 0 && (
                <div className="bg-white rounded-xl border border-red-200 p-6 shadow-sm">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
                      <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gray-900">{resultErrors}</p>
                      <p className="text-sm text-red-600 font-medium">Products Failed</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Per-collection results */}
            {transferResults.map((r, ri) => {
              const ok = r.products.filter((p) => p.status === "success");
              const errs = r.products.filter((p) => p.status === "error");
              const warns = r.products.filter((p) => p.warnings?.length > 0);
              return (
                <div key={ri} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {r.collectionError ? (
                          <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        ) : (
                          <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                        )}
                        <h3 className="text-sm font-semibold text-gray-900">{r.collectionTitle}</h3>
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${r.collectionType === "smart" ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"}`}>{r.collectionType || "custom"}</span>
                      </div>
                      <span className="text-xs text-gray-500">{ok.length} transferred{errs.length > 0 ? `, ${errs.length} failed` : ""}</span>
                    </div>
                    {r.collectionError && <p className="text-xs text-red-600 mt-1">Collection error: {r.collectionError}</p>}
                    {r.collectionWarning && <p className="text-xs text-amber-600 mt-1">{r.collectionWarning}</p>}
                  </div>

                  {errs.length > 0 && (
                    <div className="border-b border-gray-100">
                      <div className="px-6 py-2 bg-red-50/50"><p className="text-xs font-semibold text-red-700">Errors ({errs.length})</p></div>
                      {errs.map((p, i) => (
                        <div key={i} className="px-6 py-2 flex items-center gap-3 text-sm border-b border-red-100/50 last:border-b-0">
                          <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          <span className="font-medium text-gray-900 truncate">{p.title}</span>
                          <span className="text-red-600 text-xs ml-auto truncate max-w-[250px]">{p.error}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {warns.length > 0 && (
                    <div className="border-b border-gray-100">
                      <div className="px-6 py-2 bg-amber-50/50"><p className="text-xs font-semibold text-amber-700">Warnings ({warns.length})</p></div>
                      {warns.map((p, i) => (
                        <div key={i} className="px-6 py-2 flex items-center gap-3 text-sm border-b border-amber-100/50 last:border-b-0">
                          <svg className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01" /></svg>
                          <span className="font-medium text-gray-900 truncate">{p.title}</span>
                          <span className="text-amber-600 text-xs ml-auto">{p.warnings.join("; ")}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {ok.length > 0 && (
                    <div className="overflow-auto max-h-[200px]">
                      <table className="w-full"><tbody className="divide-y divide-gray-100">
                        {ok.map((p, i) => (
                          <tr key={i} className="hover:bg-gray-50/50">
                            <td className="px-6 py-2 w-8"><svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg></td>
                            <td className="px-6 py-2 text-sm font-medium text-gray-900 truncate">{p.title}</td>
                            <td className="px-6 py-2 text-xs text-gray-400 text-right font-mono">{p.warnings?.length > 0 ? "⚠" : ""}</td>
                          </tr>
                        ))}
                      </tbody></table>
                    </div>
                  )}
                </div>
              );
            })}

            <div className="flex items-center gap-3">
              <button onClick={resetAll} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: font }} className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all">
                New Transfer
              </button>
              <a href="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back to Dashboard</a>
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
