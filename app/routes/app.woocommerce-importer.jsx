import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useFetcher, useRouteError, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyFetch, shopifyGraphql } from "../lib/shopify-api.server";
import { createProductWithVariants } from "../lib/product-variants.server";
import { parseCSV } from "../lib/csv-parser";
import { smartMapColumns, confidenceLevel, templateFromMapping, applyMappingTemplate } from "../lib/smart-mapper";
import {
  WOOCOMMERCE_PRODUCT_ALIASES, WOOCOMMERCE_FIELDS, maskStructuralColumns,
  detectWooCommerceCsv, buildWooCommerceProducts,
} from "../lib/woocommerce-mapper";
import { FileSourcePicker, AISummary, generateMappingSummary, generateImportResultSummary } from "../components/ui";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

// ═══════════════════════════════════════════════════════════════════
// Phase 4 — WooCommerce → Shopify cross-platform import.
//
// Reuses the same infrastructure as app.product-importer.jsx: the shared
// CSV parser, the smartMapColumns engine (with a WooCommerce-specific
// alias dictionary — see woocommerce-mapper.js), the field-mapping
// template system (Item 3), and the productCreate +
// productVariantsBulkCreate path (product-variants.server.js). Only the
// row-grouping step differs, because WooCommerce exports one row PER
// VARIATION rather than one row per product — see
// woocommerce-mapper.js's buildWooCommerceProducts for why that needs
// its own folding logic instead of the generic handle/title grouping.
// ═══════════════════════════════════════════════════════════════════

const MAPPING_IMPORT_TYPE = "woocommerce";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  let products;
  try {
    products = JSON.parse(formData.get("products"));
  } catch {
    return { results: [], successCount: 0, errorCount: 1, status: "failed", error: "Invalid product data received" };
  }
  const fileName = formData.get("fileName");

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";

  let defaultLocationId = null;
  try {
    const locRes = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: `{ locations(first: 1) { edges { node { id } } } }` }),
    });
    const locData = await locRes.json();
    defaultLocationId = locData?.data?.locations?.edges?.[0]?.node?.id || null;
  } catch { /* non-fatal */ }

  const CONCURRENCY = 5;

  // Idempotency (Phase 1 convention, extended to this new import path): every
  // WooCommerce product is given a deterministic handle in
  // woocommerce-mapper.js (SKU, falling back to slugified title) precisely so
  // this lookup-by-handle dedupe actually catches a re-run of the same file.
  async function findExistingProductByHandle(handle) {
    if (!handle) return null;
    try {
      const res = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: `{ products(first: 1, query: "handle:${handle}") { edges { node { id } } } }` }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const node = data?.data?.products?.edges?.[0]?.node;
      return node ? { id: node.id.split("/").pop() } : null;
    } catch {
      return null;
    }
  }

  async function processProduct(product, i) {
    try {
      if (product.handle) {
        const existing = await findExistingProductByHandle(product.handle);
        if (existing) {
          return {
            row: i + 1, title: product.title, status: "success", productId: existing.id,
            variantCount: 0, videoNote: " (Skipped — a product with this handle already exists)", skipped: true,
          };
        }
      }

      const productInput = { title: product.title || "Untitled Product" };
      if (product.body_html) productInput.descriptionHtml = product.body_html;
      if (product.vendor) productInput.vendor = product.vendor;
      if (product.product_type) productInput.productType = product.product_type;
      if (product.tags) productInput.tags = product.tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (product.handle) productInput.handle = product.handle;
      if (product.published !== undefined && product.published !== "") {
        productInput.status = ["1", "true", "yes", "publish"].includes(String(product.published).toLowerCase()) ? "ACTIVE" : "DRAFT";
      }

      const optionNames = [product.option1_name, product.option2_name, product.option3_name].filter(Boolean);
      const warnings = [];
      const normalizedVariants = (product.variants || []).map((v) => {
        const gv = {};
        const opts = [v.option1, v.option2, v.option3].filter(Boolean);
        if (opts.length) gv.options = opts;
        if (v.price !== undefined) gv.price = v.price;
        if (v.compareAtPrice) gv.compareAtPrice = v.compareAtPrice;
        if (v.sku) gv.sku = v.sku;
        if (v.barcode) gv.barcode = v.barcode;
        if (v.inventory_quantity !== undefined && defaultLocationId) {
          gv.inventoryQuantity = v.inventory_quantity;
          gv.locationId = defaultLocationId;
        }
        if (v.weight !== undefined) gv.weight = v.weight;
        if (v.weight_unit) gv.weightUnit = v.weight_unit;
        return gv;
      });

      let created;
      try {
        created = await createProductWithVariants({
          shopifyGraphql,
          shop: shopDomain, token: accessToken, version,
          product: productInput, optionNames, variants: normalizedVariants,
        });
      } catch (err) {
        console.error(`[importzo/woocommerce] productCreate failed for "${product.title}":`, err.message);
        throw err;
      }
      const productGid = created.gid;
      const numericId = created.id;

      if (product.images && product.images.length > 0) {
        const seen = new Set();
        const validImages = [];
        for (const src of product.images) {
          const trimmed = (src || "").trim();
          if (trimmed && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
            seen.add(trimmed);
            validImages.push(trimmed);
          }
        }
        const capped = validImages.slice(0, 250);
        if (validImages.length > 250) warnings.push(`${validImages.length} images found, capped to Shopify limit of 250`);
        if (capped.length > 0) {
          try {
            const imgRes = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
              body: JSON.stringify({
                query: `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                  productCreateMedia(productId: $productId, media: $media) {
                    media { ... on MediaImage { id } }
                    mediaUserErrors { field message }
                  }
                }`,
                variables: { productId: productGid, media: capped.map((url) => ({ originalSource: url, mediaContentType: "IMAGE" })) },
              }),
            });
            const imgData = await imgRes.json();
            const imgErrors = imgData?.data?.productCreateMedia?.mediaUserErrors || [];
            if (imgErrors.length) warnings.push(`Image issues: ${imgErrors.map((e) => e.message).join("; ")}`);
          } catch { /* non-fatal — product was created, images failed */ }
        }
      }

      return {
        row: i + 1, title: product.title, status: "success", productId: numericId,
        variantCount: product.variants?.length || 1,
        videoNote: warnings.length > 0 ? ` (${warnings.join("; ")})` : "",
      };
    } catch (error) {
      return { row: i + 1, title: product.title, status: "error", error: error.message };
    }
  }

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const slice = products.slice(i, i + CONCURRENCY);
    const sliceResults = await Promise.all(slice.map((product, idx) => processProduct(product, i + idx)));
    for (const r of sliceResults) {
      results.push(r);
      if (r.status === "success") successCount++; else errorCount++;
    }
  }

  const status = errorCount === 0 ? "completed" : successCount === 0 ? "failed" : "completed_with_errors";

  await prisma.importJob.create({
    data: {
      shop: session.shop,
      fileName: fileName || "woocommerce-export.csv",
      totalRows: products.length,
      successCount, errorCount, status,
      results: JSON.stringify(results),
      importType: "woocommerce",
    },
  });

  return { results, successCount, errorCount, status };
};

const STEP_UPLOAD = 0;
const STEP_MAP = 1;
const STEP_PREVIEW = 2;
const STEP_IMPORT = 3;

export default function WooCommerceImportPage() {
  const fetcher = useFetcher();
  const templatesFetcher = useFetcher();
  const templateActionFetcher = useFetcher();
  const shopify = useAppBridge();
  const fileInputRef = useRef(null);

  const [step, setStep] = useState(STEP_UPLOAD);
  const [fileName, setFileName] = useState("");
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [confidence, setConfidence] = useState({});
  const [confirmed, setConfirmed] = useState(new Set());
  const [wooDetected, setWooDetected] = useState(true);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [newTemplateName, setNewTemplateName] = useState("");

  const isImporting = ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  useEffect(() => {
    if (templatesFetcher.state === "idle" && !templatesFetcher.data) {
      templatesFetcher.load(`/api/mapping-templates?importType=${MAPPING_IMPORT_TYPE}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const templates = useMemo(() => templatesFetcher.data?.templates || [], [templatesFetcher.data]);
  const reloadTemplates = useCallback(() => {
    templatesFetcher.load(`/api/mapping-templates?importType=${MAPPING_IMPORT_TYPE}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (templateActionFetcher.data?.ok && templateActionFetcher.state === "idle") reloadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateActionFetcher.data, templateActionFetcher.state]);

  const structuralIndices = useMemo(() => {
    const masked = maskStructuralColumns(csvHeaders);
    const set = new Set();
    masked.forEach((h, i) => { if (h === "" && csvHeaders[i] !== "") set.add(i); });
    return set;
  }, [csvHeaders]);

  useEffect(() => {
    if (fetcher.data?.results) {
      setStep(STEP_IMPORT);
      if (fetcher.data.errorCount > 0) setErrorsExpanded(true);
      if (fetcher.data.status === "completed") {
        shopify.toast.show(`Successfully imported ${fetcher.data.successCount} products`);
      } else if (fetcher.data.status === "completed_with_errors") {
        shopify.toast.show(`Imported ${fetcher.data.successCount} products with ${fetcher.data.errorCount} errors`, { isError: true });
      } else {
        shopify.toast.show("Import failed", { isError: true });
      }
    }
  }, [fetcher.data, shopify]);

  const handleFile = useCallback((file) => {
    if (!file || !file.name.endsWith(".csv")) {
      shopify.toast.show("Please upload a CSV file", { isError: true });
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      if (rows.length < 2) {
        shopify.toast.show("CSV must have a header row and at least one data row", { isError: true });
        return;
      }
      const headers = rows[0];
      const dataRows = rows.slice(1).filter((r) => r.some((cell) => cell.trim()));
      setCsvHeaders(headers);
      setCsvRows(dataRows);

      const detected = detectWooCommerceCsv(headers);
      setWooDetected(detected);
      const { mapping: detectedMapping, confidence: detectedConfidence } = smartMapColumns(
        maskStructuralColumns(headers), dataRows, WOOCOMMERCE_PRODUCT_ALIASES, { multiMap: ["image_src"] },
      );
      setMapping(detectedMapping);
      setConfidence(detectedConfidence);
      shopify.toast.show(detected ? "WooCommerce export detected. Auto-mapped." : "Mapped as best we could — this doesn't look like a native WooCommerce export.");
      setStep(STEP_MAP);
    };
    reader.readAsText(file);
  }, [shopify]);

  const handleDrop = useCallback((e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }, [handleFile]);

  const handleMappingChange = useCallback((colIndex, value) => {
    setMapping((prev) => ({ ...prev, [colIndex]: value }));
    setConfidence((prev) => ({ ...prev, [colIndex]: value ? 100 : 0 }));
    setConfirmed((prev) => { const next = new Set(prev); if (value) next.add(colIndex); else next.delete(colIndex); return next; });
  }, []);

  const applyTemplate = useCallback((templateId) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    const { mapping: appliedMapping, confidence: appliedConfidence, matchedCount, unmatchedTemplateKeys } =
      applyMappingTemplate(maskStructuralColumns(csvHeaders), template.mapping);
    setMapping(appliedMapping);
    setConfidence(appliedConfidence);
    setConfirmed(new Set(Object.entries(appliedMapping).filter(([, f]) => f).map(([idx]) => parseInt(idx))));
    shopify.toast.show(unmatchedTemplateKeys.length > 0
      ? `Applied "${template.name}" — ${matchedCount} matched, ${unmatchedTemplateKeys.length} not found in this file`
      : `Applied "${template.name}" — ${matchedCount} column${matchedCount !== 1 ? "s" : ""} mapped`);
  }, [templates, csvHeaders, shopify]);

  const handleSaveTemplate = useCallback(() => {
    const name = newTemplateName.trim();
    if (!name) return;
    const template = templateFromMapping(csvHeaders, mapping);
    if (Object.keys(template).length === 0) {
      shopify.toast.show("Map at least one column before saving a template", { isError: true });
      return;
    }
    const fd = new FormData();
    fd.append("intent", "save");
    fd.append("importType", MAPPING_IMPORT_TYPE);
    fd.append("name", name);
    fd.append("mapping", JSON.stringify(template));
    templateActionFetcher.submit(fd, { method: "POST", action: "/api/mapping-templates" });
    setNewTemplateName("");
    shopify.toast.show(`Saved mapping as "${name}"`);
  }, [newTemplateName, csvHeaders, mapping, templateActionFetcher, shopify]);

  const handleDeleteTemplate = useCallback((templateId, name) => {
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", templateId);
    templateActionFetcher.submit(fd, { method: "POST", action: "/api/mapping-templates" });
    if (selectedTemplateId === templateId) setSelectedTemplateId("");
    shopify.toast.show(`Deleted "${name}"`);
  }, [templateActionFetcher, selectedTemplateId, shopify]);

  const { products: groupedProducts, warnings: groupingWarnings } = useMemo(() => {
    if (step < STEP_PREVIEW || csvHeaders.length === 0) return { products: [], warnings: [] };
    return buildWooCommerceProducts({ headers: csvHeaders, dataRows: csvRows, mapping });
  }, [step, csvHeaders, csvRows, mapping]);

  const hasTitleMapped = Object.values(mapping).includes("title");

  const handleImport = useCallback(() => {
    const { products } = buildWooCommerceProducts({ headers: csvHeaders, dataRows: csvRows, mapping });
    const formData = new FormData();
    formData.append("products", JSON.stringify(products));
    formData.append("fileName", fileName);
    fetcher.submit(formData, { method: "POST" });
  }, [csvHeaders, csvRows, mapping, fileName, fetcher]);

  const resetImport = useCallback(() => {
    setStep(STEP_UPLOAD);
    setFileName(""); setCsvHeaders([]); setCsvRows([]);
    setMapping({}); setConfidence({}); setConfirmed(new Set());
    setErrorsExpanded(false);
  }, []);

  const steps = ["Upload CSV", "Map Columns", "Preview", "Import"];
  const primary = "#17320A";
  const totalVariants = groupedProducts.reduce((sum, p) => sum + (p.variants?.length || 0), 0);

  return (
    <s-page heading="WooCommerce Import" subtitle={steps[step]} backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: "#17320A", fontFamily: "'ImportzoFont', sans-serif" }}>WooCommerce Import</span>
        </div>

        {/* ── Step Indicator ── */}
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between max-w-xl mx-auto">
            {steps.map((label, i) => (
              <div key={label} className="flex items-center flex-1 last:flex-initial">
                <div className="flex flex-col items-center gap-1.5">
                  <div style={{ width: 36, height: 36, minWidth: 36, minHeight: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600, ...(i <= step ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23, 50, 10, 0.3)" } : { background: "#E5E7EB", color: "#6b7280" }) }}>
                    {i < step ? (
                      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    ) : (i + 1)}
                  </div>
                  <span className={`text-xs font-medium hidden sm:block ${i === step ? "text-gray-900" : "text-gray-400"}`}>{label}</span>
                </div>
                {i < steps.length - 1 && (
                  <div style={{ flex: 1, height: 2, marginLeft: 12, marginRight: 12, borderRadius: 1, background: i < step ? primary : "#e5e7eb", transition: "background 0.5s" }} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ═══════════════ STEP 1: UPLOAD ═══════════════ */}
        {step === STEP_UPLOAD && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Upload your WooCommerce product export</h2>
              <p className="text-sm text-gray-500 mb-6">
                Export from WooCommerce via Products &rarr; All Products &rarr; Export. Simple and variable products (with attributes/variations) are both supported.
              </p>
              <div
                role="button" tabIndex={0}
                className="border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-all duration-200 border-gray-300 hover:border-gray-400 hover:bg-gray-50/50"
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
              >
                <div className="flex flex-col items-center gap-4">
                  <div style={{ width: 64, height: 64, borderRadius: "50%" }} className="flex items-center justify-center bg-gray-100">
                    <svg width="32" height="32" className="text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-base font-medium text-gray-700">Drag and drop your WooCommerce CSV here</p>
                    <p className="text-sm text-gray-500 mt-1">or click to browse files</p>
                  </div>
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">.csv files only</span>
                </div>
                <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
              </div>
              <div className="mt-6 pt-5 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Or import from</p>
                <FileSourcePicker onFileSelected={handleFile} accept=".csv" />
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 2: MAP COLUMNS ═══════════════ */}
        {step === STEP_MAP && (
          <div className="animate-fade-in space-y-4">
            {!wooDetected && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <span className="text-sm font-medium text-amber-800">
                  This file doesn&apos;t look like a native WooCommerce export (no recognizable Type/SKU/Price columns). You can still map columns manually below.
                </span>
              </div>
            )}
            {!hasTitleMapped && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <span className="text-sm font-medium text-amber-800">Please map at least the Title column to proceed.</span>
              </div>
            )}

            {(() => {
              const { items, variant } = generateMappingSummary(csvHeaders, mapping, confidence, confirmed, ["title"]);
              return <AISummary title="Smart Summary" items={items} variant={variant} />;
            })()}

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Saved Column Mappings</h3>
              {templates.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <select value={selectedTemplateId} onChange={(e) => { setSelectedTemplateId(e.target.value); if (e.target.value) applyTemplate(e.target.value); }}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-green-800/20 bg-white text-gray-700 max-w-[240px]">
                    <option value="">Apply a saved mapping…</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  {selectedTemplateId && (
                    <button type="button" onClick={() => { const t = templates.find((x) => x.id === selectedTemplateId); if (t) handleDeleteTemplate(t.id, t.name); }} className="text-xs font-medium text-red-600 hover:text-red-700">Delete</button>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input type="text" value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} placeholder="Save this mapping as…"
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-green-800/20 flex-1 min-w-[160px] max-w-[240px]" />
                <button type="button" onClick={handleSaveTemplate} disabled={!newTemplateName.trim()}
                  className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${newTemplateName.trim() ? "bg-gray-900 text-white hover:bg-gray-800" : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}>
                  Save mapping
                </button>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">Map CSV Columns</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Detected {csvRows.length} rows in <span className="font-medium text-gray-700">{fileName}</span>. Type/Parent/Attribute columns are handled automatically for variant grouping.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50/80">
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">CSV Column</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Shopify Field</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {csvHeaders.map((header, i) => {
                      const isStructural = structuralIndices.has(i);
                      const conf = confidence[i] || 0;
                      const level = confidenceLevel(conf);
                      const isMapped = !!mapping[i];
                      const isConfirmed = confirmed.has(i);
                      let statusLabel, statusClasses;
                      if (isStructural) { statusLabel = "Auto-handled"; statusClasses = "bg-blue-50 text-blue-700 border-blue-200"; }
                      else if (isConfirmed) { statusLabel = "Confirmed"; statusClasses = "bg-blue-50 text-blue-700 border-blue-200"; }
                      else if (isMapped && level === "high") { statusLabel = "Auto-mapped"; statusClasses = "bg-green-50 text-green-700 border-green-200"; }
                      else if (isMapped && (level === "medium" || level === "low")) { statusLabel = "Needs review"; statusClasses = "bg-amber-50 text-amber-700 border-amber-200"; }
                      else { statusLabel = null; }
                      return (
                        <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                          <td className="px-6 py-3">
                            <span className="text-sm font-medium text-gray-900">{header}</span>
                            <span className="block text-xs text-gray-400 truncate max-w-[180px]">{csvRows[0]?.[i] || ""}</span>
                          </td>
                          <td className="px-6 py-3">
                            {isStructural ? (
                              <span className="text-xs text-gray-400 italic">Variant grouping (Type/Parent/Attribute)</span>
                            ) : (
                              <select value={mapping[i] || ""} onChange={(e) => handleMappingChange(i, e.target.value)}
                                className={`w-full max-w-[220px] px-3 py-1.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-green-800/20 ${mapping[i] ? "border-green-800 bg-green-50 text-green-900 font-medium" : "border-gray-300 bg-white text-gray-600"}`}>
                                {WOOCOMMERCE_FIELDS.map((f) => (<option key={f.value} value={f.value}>{f.label}</option>))}
                              </select>
                            )}
                          </td>
                          <td className="px-6 py-3">
                            {statusLabel ? <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusClasses}`}>{statusLabel}</span> : <span className="text-xs text-gray-400">&mdash;</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_UPLOAD)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Back</button>
              <button onClick={() => setStep(STEP_PREVIEW)} disabled={!hasTitleMapped}
                style={hasTitleMapped ? { background: primary, color: "#fff", borderRadius: 8, fontWeight: 600 } : { borderRadius: 8 }}
                className={`px-5 py-2 text-sm rounded-lg transition-all ${hasTitleMapped ? "shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)] active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                Preview Products
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 3: PREVIEW ═══════════════ */}
        {step === STEP_PREVIEW && !isImporting && (
          <div className="animate-fade-in space-y-4">
            {groupingWarnings.length > 0 && (
              <AISummary icon="⚠️" title="Grouping Warnings" items={groupingWarnings.slice(0, 20)} variant="warning" />
            )}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Preview</h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {groupedProducts.length} product{groupedProducts.length !== 1 ? "s" : ""} ready to import &middot; {totalVariants} variant{totalVariants !== 1 ? "s" : ""}
                  </p>
                </div>
                <span className="inline-flex items-center self-start px-3 py-1 rounded-full text-xs font-medium" style={{ background: "rgba(13, 148, 136, 0.1)", color: "#0D9488" }}>
                  {csvRows.length} total rows
                </span>
              </div>
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50/80 sticky top-0 z-10">
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">#</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Product</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Variants</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {groupedProducts.slice(0, 50).map((product, i) => (
                      <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-6 py-3 text-sm text-gray-400 font-mono">{i + 1}</td>
                        <td className="px-6 py-3">
                          <p className="text-sm font-medium text-gray-900">{product.title || "Untitled"}</p>
                          {product.vendor && <p className="text-xs text-gray-500 mt-0.5">{product.vendor}</p>}
                        </td>
                        <td className="px-6 py-3">
                          {product.variants?.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {product.variants.slice(0, 3).map((v, vi) => (
                                <span key={vi} className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                                  {[v.option1, v.option2, v.option3].filter(Boolean).join(" / ") || v.sku || `Variant ${vi + 1}`}
                                </span>
                              ))}
                              {product.variants.length > 3 && <span className="text-xs text-gray-400 self-center">+{product.variants.length - 3} more</span>}
                            </div>
                          ) : <span className="text-xs text-gray-400">Single variant</span>}
                        </td>
                        <td className="px-6 py-3 text-xs text-gray-500 max-w-[250px]">
                          {[product.product_type && `Type: ${product.product_type}`, product.tags && `Tags: ${product.tags}`, product.variants?.[0]?.price && `$${product.variants[0].price}`].filter(Boolean).join(" · ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {groupedProducts.length > 50 && (
                <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50">
                  <p className="text-xs text-gray-500">Showing first 50 of {groupedProducts.length} products</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_MAP)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Back</button>
              <button onClick={handleImport} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600 }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)] transition-all active:scale-[0.98]">
                Import {groupedProducts.length} Product{groupedProducts.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ LOADING STATE ═══════════════ */}
        {isImporting && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-8 sm:p-10 shadow-sm">
              <div className="flex flex-col items-center gap-6 max-w-md mx-auto">
                <div style={{ width: 64, height: 64, borderRadius: "50%" }} className="flex items-center justify-center bg-teal-50">
                  <svg width="32" height="32" className="animate-spin" style={{ color: primary }} fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-gray-900">Importing products from WooCommerce...</h3>
                  <p className="text-sm text-gray-500 mt-2">Please wait while your products are being created. Do not close this page.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 4: RESULTS ═══════════════ */}
        {step === STEP_IMPORT && fetcher.data?.results && (
          <div className="animate-fade-in space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-green-200 p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{fetcher.data.successCount}</p>
                    <p className="text-sm text-green-600 font-medium">Imported successfully</p>
                  </div>
                </div>
              </div>
              {fetcher.data.errorCount > 0 && (
                <div className="bg-white rounded-xl border border-red-200 p-6 shadow-sm">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                      <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gray-900">{fetcher.data.errorCount}</p>
                      <p className="text-sm text-red-600 font-medium">Failed to import</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {(() => {
              const s = generateImportResultSummary(fetcher.data.successCount, fetcher.data.errorCount, csvRows.length, "product");
              return <AISummary icon="📊" title="Import Summary" items={s.items} variant={s.variant} />;
            })()}

            {fetcher.data.errorCount > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <button onClick={() => setErrorsExpanded(!errorsExpanded)} className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <span className="text-sm font-semibold text-gray-900">Error Details ({fetcher.data.errorCount})</span>
                  </div>
                  <svg className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${errorsExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {errorsExpanded && (
                  <div className="border-t border-gray-100 overflow-auto max-h-[300px]">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-red-50/50">
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">#</th>
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Product</th>
                          <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Error</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {fetcher.data.results.filter((r) => r.status === "error").map((result) => (
                          <tr key={result.row}>
                            <td className="px-6 py-2.5 text-sm text-gray-500">{result.row}</td>
                            <td className="px-6 py-2.5 text-sm font-medium text-gray-900">{result.title || "—"}</td>
                            <td className="px-6 py-2.5 text-sm text-red-600 max-w-[350px]"><div className="break-words leading-relaxed">{result.error}</div></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button onClick={resetImport} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600 }} className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)] transition-all active:scale-[0.98]">New Import</button>
              <Link to="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Back to Dashboard</Link>
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
    <FriendlyErrorBoundary heading="WooCommerce Import" title="We couldn't load the WooCommerce Importer" message="Please try again. Your CSV file and store data are untouched." error={error} />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
