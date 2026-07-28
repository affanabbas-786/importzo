import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { parseCSV } from "../lib/csv-parser";
import {
  smartMapColumns,
  PRODUCT_ALIASES,
  COLLECTION_ALIASES,
  INVENTORY_ALIASES,
  confidenceLevel,
  confidenceColor,
} from "../lib/smart-mapper";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

// ═══════════════════════════════════════════════════════════════════
// Module definitions
// ═══════════════════════════════════════════════════════════════════
const MODULES = {
  products: {
    label: "Products",
    desc: "Products with variants, images, pricing, and SKU",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    route: "/app/product-importer",
    formKey: "products",
    aliases: PRODUCT_ALIASES,
    multiMap: ["image_src", "video_src"],
    required: ["title"],
    fields: [
      { value: "", label: "-- Skip --" },
      { value: "title", label: "Title" },
      { value: "handle", label: "Handle" },
      { value: "body_html", label: "Description (HTML)" },
      { value: "vendor", label: "Vendor" },
      { value: "product_type", label: "Product Type" },
      { value: "tags", label: "Tags" },
      { value: "published", label: "Published" },
      { value: "option1_name", label: "Option1 Name" },
      { value: "option1_value", label: "Option1 Value" },
      { value: "option2_name", label: "Option2 Name" },
      { value: "option2_value", label: "Option2 Value" },
      { value: "option3_name", label: "Option3 Name" },
      { value: "option3_value", label: "Option3 Value" },
      { value: "price", label: "Price" },
      { value: "sku", label: "SKU" },
      { value: "barcode", label: "Barcode" },
      { value: "inventory_quantity", label: "Inventory Quantity" },
      { value: "weight", label: "Weight" },
      { value: "weight_unit", label: "Weight Unit" },
      { value: "image_src", label: "Image Src (multi)" },
      { value: "video_src", label: "Video URL (multi)" },
      { value: "variant_inventory_policy", label: "Variant Inventory Policy" },
      { value: "variant_fulfillment_service", label: "Variant Fulfillment Service" },
    ],
    sample: "Title,Description,Vendor,Product Type,Tags,Price,SKU,Inventory,Image URL\n\"Example Product\",\"A great product\",\"Acme\",\"Apparel\",\"summer\",29.99,\"SKU-001\",100,\"https://example.com/img.jpg\"",
  },
  collections: {
    label: "Collections",
    desc: "Custom and smart collections",
    icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z",
    route: "/app/collections",
    formKey: "collections",
    aliases: COLLECTION_ALIASES,
    multiMap: [],
    required: ["title"],
    fields: [
      { value: "", label: "-- Skip --" },
      { value: "title", label: "Title" },
      { value: "body_html", label: "Body HTML" },
      { value: "image_url", label: "Image URL" },
      { value: "sort_order", label: "Sort Order" },
      { value: "published", label: "Published" },
      { value: "collection_type", label: "Type (custom/smart)" },
      { value: "rules_column", label: "Smart Rules" },
    ],
    sample: "Title,Description,Type,Published\n\"Summer Collection\",\"Hot items\",\"custom\",\"true\"",
  },
  inventory: {
    label: "Inventory",
    desc: "Update stock by SKU and location",
    icon: "M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z",
    route: "/app/inventory",
    formKey: "items",
    aliases: INVENTORY_ALIASES,
    multiMap: [],
    required: ["sku", "quantity"],
    fields: [
      { value: "", label: "-- Skip --" },
      { value: "sku", label: "SKU" },
      { value: "location", label: "Location Name" },
      { value: "quantity", label: "Quantity / Available" },
    ],
    sample: "SKU,Quantity,Location\n\"SKU-001\",50,\"Main Warehouse\"",
  },
};

const MODULE_KEYS = Object.keys(MODULES);
const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";
const STEPS = ["Configure", "Upload", "Map Fields", "Review", "Import", "Results"];
const STEP_CONFIG = 0, STEP_UPLOAD = 1, STEP_MAP = 2, STEP_REVIEW = 3, STEP_IMPORT = 4, STEP_RESULTS = 5;

// ═══════════════════════════════════════════════════════════════════
// Data processors — build submission payloads from mapped CSV data
// ═══════════════════════════════════════════════════════════════════

function buildProducts(headers, rows, mapping) {
  const imgCols = Object.entries(mapping).filter(([, f]) => f === "image_src").map(([i]) => +i);
  const vidCols = Object.entries(mapping).filter(([, f]) => f === "video_src").map(([i]) => +i);

  const mapped = rows.map((row) => {
    const o = {};
    Object.entries(mapping).forEach(([ci, f]) => {
      if (f && f !== "image_src" && f !== "video_src" && row[ci] !== undefined) o[f] = (row[ci] || "").trim();
    });
    o._images = []; o._videos = [];
    imgCols.forEach((i) => { if (row[i]) row[i].split(",").map((u) => u.trim()).filter(Boolean).forEach((u) => { if (!o._images.includes(u)) o._images.push(u); }); });
    vidCols.forEach((i) => { if (row[i]) row[i].split(",").map((u) => u.trim()).filter(Boolean).forEach((u) => { if (!o._videos.includes(u)) o._videos.push(u); }); });
    return o;
  });

  const deriveOpt = (field) => {
    const nf = field.replace("_value", "_name");
    if (Object.values(mapping).includes(nf)) return null;
    const e = Object.entries(mapping).find(([, f]) => f === field);
    if (!e) return null;
    const h = headers[+e[0]];
    if (!h) return null;
    const n = h.toLowerCase().replace(/[^a-z0-9]/g, "");
    if ((n.includes("option") && (n.includes("value") || n.includes("val"))) || /^option\d$/.test(n)) return null;
    return h;
  };
  const auto1 = deriveOpt("option1_value"), auto2 = deriveOpt("option2_value"), auto3 = deriveOpt("option3_value");
  const hasHandle = Object.values(mapping).includes("handle");
  const hasOpts = Object.values(mapping).some((f) => f.startsWith("option"));

  if (!hasHandle && !hasOpts) {
    return mapped.map((r) => {
      const p = {};
      ["title","body_html","vendor","product_type","tags","handle","published"].forEach((f) => { if (r[f]) p[f] = r[f]; });
      const v = {};
      ["price","sku","barcode","inventory_quantity","weight","weight_unit"].forEach((f) => { if (r[f]) v[f] = r[f]; });
      if (r.variant_inventory_policy) v.inventory_policy = r.variant_inventory_policy;
      if (r.variant_fulfillment_service) v.fulfillment_service = r.variant_fulfillment_service;
      if (Object.keys(v).length) p.variants = [v];
      if (r._images.length) p.images = r._images;
      if (r._videos.length) p.videos = r._videos;
      return p;
    });
  }

  const grouped = {}, order = [];
  let lastKey = null;
  mapped.forEach((r) => {
    let key = r.handle || r.title;
    if (!key) key = lastKey || "untitled"; else lastKey = key;
    if (!grouped[key]) {
      grouped[key] = {
        title: r.title || "", body_html: r.body_html || "", vendor: r.vendor || "",
        product_type: r.product_type || "", tags: r.tags || "", handle: r.handle || "",
        published: r.published || "", option1_name: r.option1_name || auto1 || "",
        option2_name: r.option2_name || auto2 || "", option3_name: r.option3_name || auto3 || "",
        variants: [], images: [], videos: [],
      };
      order.push(key);
    }
    const g = grouped[key];
    if (r.title && !g.title) g.title = r.title;
    if (r.body_html && !g.body_html) g.body_html = r.body_html;
    if (r.vendor && !g.vendor) g.vendor = r.vendor;
    if (r.product_type && !g.product_type) g.product_type = r.product_type;
    if (r.tags && !g.tags) g.tags = r.tags;

    const v = {};
    if (r.option1_value) v.option1 = r.option1_value;
    if (r.option2_value) v.option2 = r.option2_value;
    if (r.option3_value) v.option3 = r.option3_value;
    ["price","sku","barcode","inventory_quantity","weight","weight_unit"].forEach((f) => { if (r[f]) v[f] = r[f]; });
    if (r.variant_inventory_policy) v.inventory_policy = r.variant_inventory_policy;
    if (r.variant_fulfillment_service) v.fulfillment_service = r.variant_fulfillment_service;
    if (Object.keys(v).length) g.variants.push(v);
    r._images.forEach((u) => { if (!g.images.includes(u)) g.images.push(u); });
    r._videos.forEach((u) => { if (!g.videos.includes(u)) g.videos.push(u); });
  });
  return order.map((k) => grouped[k]);
}

function buildCollections(rows, mapping) {
  return rows.map((row) => {
    const o = {};
    Object.entries(mapping).forEach(([ci, f]) => { if (f && row[ci] !== undefined) o[f] = (row[ci] || "").trim(); });
    return o;
  });
}

function buildInventory(rows, mapping) {
  return rows.map((row) => {
    const o = {};
    Object.entries(mapping).forEach(([ci, f]) => { if (f && row[ci] !== undefined) o[f] = (row[ci] || "").trim(); });
    return o;
  }).filter((i) => i.sku);
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function getMissing(mapping, required) {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  return required.filter((f) => !mapped.has(f));
}

function fieldStatus(colIdx, mapping, confidence, confirmed) {
  if (!mapping[colIdx]) return null;
  if (confirmed[colIdx]) return { label: "Confirmed", cls: "bg-blue-50 text-blue-700 border-blue-200" };
  const c = confidence[colIdx] || 0;
  if (c >= 85) return { label: "Auto-mapped", cls: "bg-green-50 text-green-700 border-green-200" };
  if (c >= 50) return { label: "Needs review", cls: "bg-amber-50 text-amber-700 border-amber-200" };
  return { label: "Needs review", cls: "bg-red-50 text-red-700 border-red-200" };
}

function downloadSample(mod) {
  const cfg = MODULES[mod];
  const blob = new Blob([cfg.sample], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `sample-${mod}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

function downloadErrors(modKey, results) {
  const errs = (results || []).filter((r) => r.status === "error" || r.status === "not_found");
  if (!errs.length) return;
  const csv = [["Row", "Item", "Error"], ...errs.map((e) => [e.row, e.title || e.sku || "", e.error || ""])].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `errors-${modKey}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════
export default function FullImportPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [step, setStep] = useState(STEP_CONFIG);

  // Step 0: Config
  const [enabled, setEnabled] = useState({ products: true, collections: true, inventory: true });
  const [dryRun, setDryRun] = useState(false);

  // Step 1-2: Per-module data
  const [modData, setModData] = useState({}); // { [mod]: { fileName, headers, rows, mapping, confidence, confirmed } }
  const [activeTab, setActiveTab] = useState("products");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Step 4-5: Import orchestration
  const [importQueue, setImportQueue] = useState([]);
  const [importIdx, setImportIdx] = useState(-1);
  const [modResults, setModResults] = useState({});
  const prevFetcherState = useRef("idle");

  const enabledMods = MODULE_KEYS.filter((k) => enabled[k]);
  const uploadedMods = enabledMods.filter((k) => modData[k]?.rows?.length > 0);
  const allUploaded = enabledMods.length > 0 && enabledMods.every((k) => modData[k]?.rows?.length > 0);

  // ── File handler (shared for all modules) ──
  const handleFile = useCallback((mod, file) => {
    if (!file || !file.name.match(/\.csv$/i)) { shopify.toast.show("Please upload a CSV file", { isError: true }); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      if (rows.length < 2) { shopify.toast.show("CSV needs a header row and data", { isError: true }); return; }
      const headers = rows[0];
      const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim()));
      const cfg = MODULES[mod];
      const { mapping, confidence } = smartMapColumns(headers, dataRows, cfg.aliases, { multiMap: cfg.multiMap || [] });
      const confirmed = {};
      headers.forEach((_, i) => { confirmed[i] = false; });
      setModData((prev) => ({ ...prev, [mod]: { fileName: file.name, headers, rows: dataRows, mapping, confidence, confirmed } }));
      shopify.toast.show(`${cfg.label}: ${dataRows.length} rows detected`);
    };
    reader.readAsText(file);
  }, [shopify]);

  const removeFile = useCallback((mod) => {
    setModData((prev) => { const n = { ...prev }; delete n[mod]; return n; });
  }, []);

  const updateMapping = useCallback((mod, colIdx, value) => {
    setModData((prev) => {
      const d = { ...prev[mod] };
      d.mapping = { ...d.mapping, [colIdx]: value };
      d.confidence = { ...d.confidence, [colIdx]: value ? 100 : 0 };
      d.confirmed = { ...d.confirmed, [colIdx]: !!value };
      return { ...prev, [mod]: d };
    });
  }, []);

  // ── Build processed data per module ──
  const getProcessed = useCallback((mod) => {
    const d = modData[mod];
    if (!d) return [];
    if (mod === "products") return buildProducts(d.headers, d.rows, d.mapping);
    if (mod === "collections") return buildCollections(d.rows, d.mapping);
    if (mod === "inventory") return buildInventory(d.rows, d.mapping);
    return [];
  }, [modData]);

  // ── Validation per module ──
  const getValidation = useCallback((mod) => {
    const d = modData[mod];
    if (!d) return { missing: [], dupes: 0, warnings: [] };
    const cfg = MODULES[mod];
    const missing = getMissing(d.mapping, cfg.required);
    const processed = getProcessed(mod);
    const warnings = [];
    let dupes = 0;
    if (mod === "products") {
      const titles = processed.map((p) => p.title).filter(Boolean);
      dupes = titles.length - new Set(titles).size;
      const noTitle = processed.filter((p) => !p.title).length;
      if (noTitle) warnings.push(`${noTitle} product${noTitle > 1 ? "s" : ""} missing title`);
    } else if (mod === "collections") {
      const titles = processed.map((c) => c.title).filter(Boolean);
      dupes = titles.length - new Set(titles).size;
    } else if (mod === "inventory") {
      const skus = processed.map((i) => i.sku);
      dupes = skus.length - new Set(skus).size;
    }
    if (dupes > 0) warnings.push(`${dupes} duplicate${dupes > 1 ? "s" : ""} in file`);
    return { missing, dupes, warnings, count: processed.length };
  }, [modData, getProcessed]);

  const allMappingValid = enabledMods.every((mod) => {
    if (!modData[mod]) return false;
    return getMissing(modData[mod].mapping, MODULES[mod].required).length === 0;
  });

  // ── Import orchestration ──
  const submitModule = useCallback((mod) => {
    const processed = getProcessed(mod);
    const cfg = MODULES[mod];
    const fd = new FormData();
    fd.append(cfg.formKey, JSON.stringify(processed));
    fd.append("fileName", `full-import-${modData[mod]?.fileName || "data.csv"}`);
    fetcher.submit(fd, { method: "POST", action: cfg.route });
  }, [fetcher, getProcessed, modData]);

  const startImport = useCallback(() => {
    if (dryRun) {
      // Dry run: skip API calls, show validation as results
      const res = {};
      enabledMods.forEach((mod) => {
        const v = getValidation(mod);
        const p = getProcessed(mod);
        res[mod] = {
          dryRun: true,
          successCount: v.missing.length === 0 ? p.length : 0,
          errorCount: v.warnings.length,
          totalCount: p.length,
          warnings: v.warnings,
          missing: v.missing,
        };
      });
      setModResults(res);
      setStep(STEP_RESULTS);
      shopify.toast.show("Dry run complete — no changes were made");
      return;
    }
    const queue = uploadedMods;
    setImportQueue(queue);
    setImportIdx(0);
    setModResults({});
    setStep(STEP_IMPORT);
    submitModule(queue[0]);
  }, [dryRun, enabledMods, uploadedMods, getValidation, getProcessed, submitModule, shopify]);

  // Watch fetcher transitions to advance the queue
  useEffect(() => {
    if (prevFetcherState.current !== "idle" && fetcher.state === "idle" && fetcher.data && step === STEP_IMPORT && importIdx >= 0) {
      const mod = importQueue[importIdx];
      const newResults = { ...modResults, [mod]: fetcher.data };
      setModResults(newResults);
      const next = importIdx + 1;
      if (next < importQueue.length) {
        setImportIdx(next);
        submitModule(importQueue[next]);
      } else {
        setImportIdx(-1);
        setStep(STEP_RESULTS);
        const total = Object.values(newResults).reduce((s, r) => s + (r.successCount || r.updatedCount || 0), 0);
        shopify.toast.show(`Import complete — ${total} records processed`);
      }
    }
    prevFetcherState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, step, importIdx, importQueue, modResults, submitModule, shopify]);

  const reset = useCallback(() => {
    setStep(STEP_CONFIG);
    setModData({});
    setModResults({});
    setImportQueue([]);
    setImportIdx(-1);
    setDryRun(false);
    setShowAdvanced(false);
  }, []);

  // ── Step nav guard ──
  const canAdvance = (s) => {
    if (s === STEP_CONFIG) return enabledMods.length > 0;
    if (s === STEP_UPLOAD) return allUploaded;
    if (s === STEP_MAP) return allMappingValid;
    if (s === STEP_REVIEW) return true;
    return false;
  };

  // ═══════════════════════════════════════════════════════════════════
  return (
    <s-page heading="Full Store Import" backAction={JSON.stringify({ content: "Import", url: "/app/import" })}>
      <div className="space-y-6 animate-fade-in">
        {/* ── Header ── */}
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }}>Full Store Import</span>
        </div>

        {/* ── Stepper ── */}
        <div className="px-1 pb-1">
          <div className="flex items-center justify-between max-w-2xl mx-auto">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center flex-1 last:flex-initial">
                <div className="flex flex-col items-center gap-1">
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600,
                    ...(i < step ? { background: P, color: "#fff" } : i === step ? { background: P, color: "#fff", boxShadow: "0 3px 10px rgba(23,50,10,0.3)" } : { background: "#E5E7EB", color: "#9ca3af" }),
                  }}>
                    {i < step ? <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> : i + 1}
                  </div>
                  <span className={`text-[10px] font-medium hidden sm:block ${i === step ? "text-gray-800" : "text-gray-400"}`}>{label}</span>
                </div>
                {i < STEPS.length - 1 && <div style={{ flex: 1, height: 2, margin: "0 8px", borderRadius: 1, background: i < step ? P : "#e5e7eb" }} />}
              </div>
            ))}
          </div>
        </div>

        {/* ═══════════════ STEP 0: CONFIGURE ═══════════════ */}
        {step === STEP_CONFIG && (
          <div className="space-y-4 animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900 mb-1" style={{ fontFamily: F }}>What do you want to import?</h2>
              <p className="text-xs text-gray-500 mb-5">Select the data types to include. You can upload a separate CSV for each.</p>

              <div className="space-y-3">
                {/* Select all / Clear */}
                <div className="flex gap-3 mb-1">
                  <button onClick={() => setEnabled({ products: true, collections: true, inventory: true })} className="text-xs font-medium hover:underline" style={{ color: S }}>Select all</button>
                  <button onClick={() => setEnabled({ products: false, collections: false, inventory: false })} className="text-xs font-medium text-gray-400 hover:underline">Clear all</button>
                </div>

                {MODULE_KEYS.map((mod) => {
                  const cfg = MODULES[mod];
                  return (
                    <label key={mod} htmlFor={`module-${mod}`} aria-label={cfg.label} className={`flex items-center gap-4 rounded-lg border p-4 cursor-pointer transition-all ${enabled[mod] ? "border-green-800/30 bg-green-50/30" : "border-gray-200 hover:border-gray-300"}`}>
                      <input id={`module-${mod}`} type="checkbox" checked={enabled[mod]} onChange={(e) => setEnabled((p) => ({ ...p, [mod]: e.target.checked }))}
                        className="w-4 h-4 rounded border-gray-300 accent-green-800" style={{ accentColor: P }} />
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: enabled[mod] ? "rgba(23,50,10,0.1)" : "#f3f4f6", color: enabled[mod] ? S : "#9ca3af" }}>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={cfg.icon} /></svg>
                      </div>
                      <div>
                        <p className={`text-sm font-medium ${enabled[mod] ? "text-gray-900" : "text-gray-500"}`}>{cfg.label}</p>
                        <p className="text-xs text-gray-400">{cfg.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Options row */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <label htmlFor="dry-run-checkbox" aria-label="Dry run (test mode)" className="flex items-center gap-3 cursor-pointer">
                <input id="dry-run-checkbox" type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="w-4 h-4 rounded border-gray-300" style={{ accentColor: P }} />
                <div>
                  <p className="text-sm font-medium text-gray-900">Dry run (test mode)</p>
                  <p className="text-xs text-gray-400">Validate everything without making changes to your store</p>
                </div>
              </label>
            </div>

            <div className="flex items-center gap-3">
              <Link to="/app/import" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</Link>
              <button onClick={() => { setActiveTab(enabledMods[0] || "products"); setStep(STEP_UPLOAD); }} disabled={!canAdvance(STEP_CONFIG)}
                style={canAdvance(STEP_CONFIG) ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                className={`px-5 py-2 text-sm rounded-lg transition-all ${canAdvance(STEP_CONFIG) ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                Continue
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 1: UPLOAD ═══════════════ */}
        {step === STEP_UPLOAD && (
          <div className="space-y-4 animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900 mb-1" style={{ fontFamily: F }}>Upload your CSV files</h2>
              <p className="text-xs text-gray-500 mb-5">One file per data type. We&apos;ll auto-detect columns and delimiters.</p>

              <div className="space-y-4">
                {enabledMods.map((mod) => {
                  const cfg = MODULES[mod];
                  const d = modData[mod];
                  return (
                    <div key={mod} className={`rounded-lg border p-4 ${d ? "border-green-800/20 bg-green-50/20" : "border-gray-200"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4" style={{ color: S }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={cfg.icon} /></svg>
                          <span className="text-sm font-semibold text-gray-800">{cfg.label}</span>
                          {d && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700">{d.rows.length} rows</span>}
                        </div>
                        <button onClick={() => downloadSample(mod)} className="text-[10px] font-medium hover:underline" style={{ color: S }}>Download sample</button>
                      </div>
                      {d ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 font-medium truncate flex-1">{d.fileName}</span>
                          <span className="text-[10px] text-gray-400">{d.headers.length} cols</span>
                          <label className="text-[10px] font-medium cursor-pointer hover:underline" style={{ color: S }}>
                            Replace
                            <input type="file" accept=".csv" className="hidden" onChange={(e) => { if (e.target.files[0]) handleFile(mod, e.target.files[0]); e.target.value = ""; }} />
                          </label>
                          <button onClick={() => removeFile(mod)} className="text-[10px] font-medium text-red-500 hover:underline">Remove</button>
                        </div>
                      ) : (
                        <label className="block border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-gray-400 hover:bg-gray-50/50 transition-all">
                          <p className="text-xs text-gray-500">Drop CSV here or <span className="font-medium" style={{ color: S }}>browse</span></p>
                          <input type="file" accept=".csv" className="hidden" onChange={(e) => { if (e.target.files[0]) handleFile(mod, e.target.files[0]); e.target.value = ""; }} />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_CONFIG)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={() => { setActiveTab(enabledMods[0]); setStep(STEP_MAP); }} disabled={!allUploaded}
                style={allUploaded ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                className={`px-5 py-2 text-sm rounded-lg transition-all ${allUploaded ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                Continue to Mapping
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 2: MAP FIELDS ═══════════════ */}
        {step === STEP_MAP && (
          <div className="space-y-4 animate-fade-in">
            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {enabledMods.map((mod) => {
                const missing = getMissing(modData[mod]?.mapping || {}, MODULES[mod].required);
                return (
                  <button key={mod} onClick={() => setActiveTab(mod)}
                    className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md transition-all ${activeTab === mod ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                    {MODULES[mod].label}
                    {missing.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
                    {missing.length === 0 && modData[mod] && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
                  </button>
                );
              })}
            </div>

            {/* Mapping table for active tab */}
            {modData[activeTab] && (() => {
              const d = modData[activeTab];
              const cfg = MODULES[activeTab];
              const missing = getMissing(d.mapping, cfg.required);
              return (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">{cfg.label} Mapping</h3>
                      <p className="text-[10px] text-gray-400 mt-0.5">{d.rows.length} rows &middot; {d.headers.length} columns from {d.fileName}</p>
                    </div>
                    {missing.length > 0 && (
                      <span className="text-[10px] font-medium text-red-600 bg-red-50 px-2 py-1 rounded">
                        Missing: {missing.map((f) => cfg.fields.find((x) => x.value === f)?.label || f).join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead><tr className="bg-gray-50/80">
                        <th className="px-5 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Source Column</th>
                        <th className="px-5 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Sample</th>
                        <th className="px-5 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Shopify Field</th>
                        <th className="px-5 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                      </tr></thead>
                      <tbody className="divide-y divide-gray-100">
                        {d.headers.map((header, i) => {
                          const st = fieldStatus(i, d.mapping, d.confidence, d.confirmed);
                          const isMissingReq = !d.mapping[i] && cfg.required.some((r) => !Object.values(d.mapping).includes(r));
                          return (
                            <tr key={i} className="hover:bg-gray-50/50">
                              <td className="px-5 py-2.5"><span className="text-sm font-medium text-gray-900">{header}</span></td>
                              <td className="px-5 py-2.5 max-w-[160px]"><span className="text-xs text-gray-400 truncate block">{d.rows[0]?.[i] || "\u2014"}</span></td>
                              <td className="px-5 py-2.5">
                                <select value={d.mapping[i] || ""} onChange={(e) => updateMapping(activeTab, i, e.target.value)}
                                  className={`w-full max-w-[200px] px-2.5 py-1.5 text-xs border rounded-lg outline-none transition-all focus:ring-2 focus:ring-green-800/20 ${d.mapping[i] ? "border-green-800/40 bg-green-50/50 text-green-900 font-medium" : "border-gray-300 text-gray-500"}`}>
                                  {cfg.fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                                </select>
                              </td>
                              <td className="px-5 py-2.5">
                                {st ? (
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${st.cls}`}>{st.label}</span>
                                ) : isMissingReq ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600 border border-red-200">Required</span>
                                ) : (
                                  <span className="text-[10px] text-gray-300">&mdash;</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Advanced details (collapsed) */}
                  <div className="border-t border-gray-100">
                    <button onClick={() => setShowAdvanced(!showAdvanced)} className="w-full px-5 py-2.5 flex items-center gap-2 text-[10px] font-medium text-gray-400 hover:text-gray-600 transition-colors">
                      <svg className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                      Advanced details
                    </button>
                    {showAdvanced && (
                      <div className="px-5 pb-3">
                        <table className="w-full">
                          <thead><tr><th className="text-left text-[9px] text-gray-300 uppercase pb-1">Column</th><th className="text-left text-[9px] text-gray-300 uppercase pb-1">Field</th><th className="text-left text-[9px] text-gray-300 uppercase pb-1">Confidence</th></tr></thead>
                          <tbody>
                            {d.headers.map((h, i) => {
                              const conf = d.confidence[i] || 0;
                              const lvl = confidenceLevel(conf);
                              const clr = confidenceColor(lvl);
                              return d.mapping[i] ? (
                                <tr key={i}>
                                  <td className="py-0.5 text-[10px] text-gray-500">{h}</td>
                                  <td className="py-0.5 text-[10px] text-gray-600 font-medium">{d.mapping[i]}</td>
                                  <td className="py-0.5"><span className={`text-[10px] font-medium ${clr.text}`}>{conf}%</span></td>
                                </tr>
                              ) : null;
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_UPLOAD)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={() => setStep(STEP_REVIEW)} disabled={!allMappingValid}
                style={allMappingValid ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                className={`px-5 py-2 text-sm rounded-lg transition-all ${allMappingValid ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                Review &amp; Import
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 3: REVIEW ═══════════════ */}
        {step === STEP_REVIEW && (
          <div className="space-y-4 animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900 mb-4" style={{ fontFamily: F }}>Review before importing</h2>

              <div className="space-y-3">
                {enabledMods.map((mod) => {
                  const v = getValidation(mod);
                  const cfg = MODULES[mod];
                  const hasIssues = v.missing.length > 0 || v.warnings.length > 0;
                  return (
                    <div key={mod} className={`rounded-lg border p-4 ${hasIssues ? "border-amber-200 bg-amber-50/30" : "border-green-200 bg-green-50/20"}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {!hasIssues ? (
                            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          ) : (
                            <svg className="w-4 h-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                          )}
                          <span className="text-sm font-semibold text-gray-900">{cfg.label}</span>
                        </div>
                        <span className="text-xs font-medium text-gray-500">{v.count} record{v.count !== 1 ? "s" : ""} to {mod === "inventory" ? "update" : "create"}</span>
                      </div>
                      {v.warnings.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {v.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700">&bull; {w}</p>)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Dry run banner */}
            {dryRun && (
              <div className="rounded-lg px-4 py-3 border border-blue-200 bg-blue-50 flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <span className="text-xs font-medium text-blue-700">Dry run enabled — no changes will be made to your store</span>
              </div>
            )}

            {/* Total summary */}
            <div className="rounded-lg px-4 py-3 flex items-center justify-between" style={{ background: "rgba(23,50,10,0.06)", border: "1px solid rgba(23,50,10,0.15)" }}>
              <span className="text-xs font-medium" style={{ color: P }}>
                Total: {enabledMods.reduce((s, m) => s + (getValidation(m).count || 0), 0)} records across {enabledMods.length} module{enabledMods.length > 1 ? "s" : ""}
              </span>
              <span className="text-[10px] text-gray-400">{dryRun ? "Test mode" : "Live import"}</span>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_MAP)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={startImport}
                style={{ background: dryRun ? "#2563EB" : P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]">
                {dryRun ? "Run Test" : `Import ${enabledMods.reduce((s, m) => s + (getValidation(m).count || 0), 0)} Records`}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 4: IMPORTING ═══════════════ */}
        {step === STEP_IMPORT && (
          <div className="space-y-4 animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              <div className="flex flex-col items-center gap-4 max-w-md mx-auto text-center mb-6">
                <div className="w-14 h-14 rounded-full bg-green-50 flex items-center justify-center">
                  <svg width="28" height="28" className="animate-spin" style={{ color: P }} fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Importing your data...</h3>
                  <p className="text-xs text-gray-500 mt-1">Please don&apos;t close this page.</p>
                </div>
              </div>

              <div className="space-y-3">
                {importQueue.map((mod, i) => {
                  const cfg = MODULES[mod];
                  const isDone = !!modResults[mod];
                  const isCurrent = i === importIdx;
                  const isWaiting = i > importIdx;
                  return (
                    <div key={mod} className={`rounded-lg border px-4 py-3 flex items-center justify-between ${isDone ? "border-green-200 bg-green-50/30" : isCurrent ? "border-green-800/20 bg-green-50/10" : "border-gray-200"}`}>
                      <div className="flex items-center gap-2">
                        {isDone && <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>}
                        {isCurrent && <svg className="w-4 h-4 animate-spin" style={{ color: P }} fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
                        {isWaiting && <div className="w-4 h-4 rounded-full border-2 border-gray-300" />}
                        <span className={`text-sm font-medium ${isDone ? "text-green-700" : isCurrent ? "text-gray-900" : "text-gray-400"}`}>{cfg.label}</span>
                      </div>
                      <span className="text-[10px] text-gray-400">
                        {isDone ? `${modResults[mod].successCount || modResults[mod].updatedCount || 0} done` : isCurrent ? "Processing..." : "Waiting"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 5: RESULTS ═══════════════ */}
        {step === STEP_RESULTS && (
          <div className="space-y-4 animate-fade-in">
            {/* Dry run banner */}
            {dryRun && (
              <div className="rounded-lg px-4 py-3 border-2 border-blue-300 bg-blue-50 flex items-center gap-2">
                <svg className="w-5 h-5 text-blue-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                <span className="text-sm font-semibold text-blue-800">Dry Run — No changes were made to your store</span>
              </div>
            )}

            {/* Per-module results */}
            {enabledMods.map((mod) => {
              const r = modResults[mod];
              if (!r) return null;
              const cfg = MODULES[mod];
              const isDry = r.dryRun;
              const success = r.successCount || r.updatedCount || 0;
              const errors = r.errorCount || 0;
              const notFound = r.notFoundCount || 0;
              const totalErr = errors + notFound;
              const results = r.results || [];
              const hasErrors = totalErr > 0 || (isDry && r.warnings?.length > 0);

              return (
                <div key={mod} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4" style={{ color: S }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={cfg.icon} /></svg>
                      <h3 className="text-sm font-semibold text-gray-900">{cfg.label}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      {success > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-50 text-green-700">{success} {isDry ? "ready" : mod === "inventory" ? "updated" : "created"}</span>}
                      {totalErr > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-700">{totalErr} {isDry ? "issue" : "failed"}{totalErr > 1 ? "s" : ""}</span>}
                    </div>
                  </div>

                  {/* Error details */}
                  {hasErrors && (
                    <div className="px-5 py-3 bg-red-50/30 border-b border-red-100">
                      {isDry && r.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-700">&bull; {w}</p>)}
                      {!isDry && results.filter((x) => x.status === "error" || x.status === "not_found").slice(0, 5).map((e, i) => (
                        <p key={i} className="text-xs text-red-600">Row {e.row}: {e.error || "Not found"}</p>
                      ))}
                      {!isDry && totalErr > 5 && <p className="text-xs text-gray-400 mt-1">+{totalErr - 5} more errors</p>}
                      {!isDry && totalErr > 0 && (
                        <button onClick={() => downloadErrors(mod, results)} className="text-[10px] font-medium mt-2 hover:underline" style={{ color: S }}>
                          Download error report
                        </button>
                      )}
                    </div>
                  )}

                  {/* Retry link for failed modules */}
                  {!isDry && totalErr > 0 && (
                    <div className="px-5 py-2 border-t border-gray-100 bg-gray-50/50">
                      <a href={cfg.route} className="text-[10px] font-medium hover:underline" style={{ color: S }}>
                        Retry {cfg.label.toLowerCase()} import &rarr;
                      </a>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Grand total */}
            {!dryRun && (
              <div className="rounded-lg px-4 py-3" style={{ background: "rgba(23,50,10,0.06)", border: "1px solid rgba(23,50,10,0.15)" }}>
                <span className="text-xs font-medium" style={{ color: P }}>
                  Total: {enabledMods.reduce((s, m) => s + (modResults[m]?.successCount || modResults[m]?.updatedCount || 0), 0)} records processed
                  {enabledMods.reduce((s, m) => s + (modResults[m]?.errorCount || 0) + (modResults[m]?.notFoundCount || 0), 0) > 0 &&
                    `, ${enabledMods.reduce((s, m) => s + (modResults[m]?.errorCount || 0) + (modResults[m]?.notFoundCount || 0), 0)} failed`}
                </span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button onClick={reset}
                style={{ background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]">
                New Import
              </button>
              <Link to="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Dashboard</Link>
              <Link to="/app/activity" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">View Activity</Link>
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
      heading="Full Store Import"
      title="We couldn't load Full Import"
      message="Please try again. Nothing has been imported to your store yet — this is just a display issue."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
