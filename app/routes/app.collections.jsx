import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { parseCSV } from "../lib/csv-parser";
import { smartMapColumns, COLLECTION_ALIASES, confidenceLevel, confidenceColor } from "../lib/smart-mapper";
import { FileSourcePicker, AISummary, generateMappingSummary, generateImportResultSummary } from "../components/ui";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

const COLLECTION_FIELDS = [
  { value: "", label: "-- Skip --" },
  { value: "title", label: "Title" },
  { value: "body_html", label: "Body HTML" },
  { value: "image_url", label: "Image URL" },
  { value: "sort_order", label: "Sort Order" },
  { value: "published", label: "Published" },
  { value: "collection_type", label: "Collection Type (custom/smart)" },
  { value: "rules_column", label: "Smart Rules (column:relation:condition)" },
];

function autoDetectMapping(headers, dataRows) {
  return smartMapColumns(headers, dataRows || [], COLLECTION_ALIASES);
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  let collections;
  try {
    collections = JSON.parse(formData.get("collections") || "[]");
  } catch {
    return { results: [], successCount: 0, errorCount: 1, status: "failed" };
  }
  const fileName = formData.get("fileName") || "collections.csv";
  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";

  const SORT_ORDER_MAP = { manual: "MANUAL", "best-selling": "BEST_SELLING", "alpha-asc": "ALPHA_ASC", "alpha-desc": "ALPHA_DESC", "price-desc": "PRICE_DESC", "price-asc": "PRICE_ASC", created: "CREATED", "created-desc": "CREATED_DESC" };
  const RULE_COLUMN_MAP = { tag: "TAG", title: "TITLE", type: "TYPE", vendor: "VENDOR", variant_title: "VARIANT_TITLE", variant_price: "VARIANT_PRICE", variant_compare_at_price: "VARIANT_COMPARE_AT_PRICE", variant_weight: "VARIANT_WEIGHT", variant_inventory: "VARIANT_INVENTORY" };
  const RULE_RELATION_MAP = { equals: "EQUALS", not_equals: "NOT_EQUALS", greater_than: "GREATER_THAN", less_than: "LESS_THAN", starts_with: "STARTS_WITH", ends_with: "ENDS_WITH", contains: "CONTAINS", not_contains: "NOT_CONTAINS" };

  const CREATE_COLLECTION = `#graphql
    mutation CollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id }
        userErrors { field message }
      }
    }`;

  async function gqlCollectionCreate(input) {
    const res = await fetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: CREATE_COLLECTION, variables: { input } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const errors = json?.data?.collectionCreate?.userErrors || [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
    return json?.data?.collectionCreate?.collection;
  }

  const results = [];
  let successCount = 0, errorCount = 0;

  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    const isSmartType = (collection.collection_type || "").toLowerCase() === "smart";

    try {
      const isPublished = collection.published !== undefined && collection.published !== ""
        ? ["true", "yes", "1"].includes(String(collection.published).toLowerCase())
        : true;

      const input = {
        title: collection.title || "Untitled Collection",
        published: isPublished,
      };
      if (collection.body_html) input.descriptionHtml = collection.body_html;
      if (collection.sort_order) input.sortOrder = SORT_ORDER_MAP[collection.sort_order] || "MANUAL";

      if (isSmartType) {
        // Parse rules: format "column:relation:condition" separated by |
        const rawRules = [];
        if (collection.rules_column) {
          collection.rules_column.split("|").forEach((r) => {
            const parts = r.trim().split(":");
            if (parts.length >= 3) {
              rawRules.push({ column: parts[0].trim(), relation: parts[1].trim(), condition: parts.slice(2).join(":").trim() });
            }
          });
        }
        if (rawRules.length === 0) {
          rawRules.push({ column: "tag", relation: "equals", condition: collection.title || "imported" });
        }
        input.ruleSet = {
          appliedDisjunctively: false,
          rules: rawRules.map((r) => ({
            column: RULE_COLUMN_MAP[r.column?.toLowerCase()] || r.column?.toUpperCase() || "TAG",
            relation: RULE_RELATION_MAP[r.relation?.toLowerCase()] || r.relation?.toUpperCase() || "EQUALS",
            condition: r.condition,
          })),
        };

        const col = await gqlCollectionCreate(input);
        results.push({ row: i + 1, title: collection.title, status: "success", collectionId: col.id.split("/").pop(), type: "smart" });
        successCount++;
      } else {
        // Custom (manual) collection
        const hasImage = collection.image_url && /^https?:\/\//i.test(collection.image_url.trim());
        if (hasImage) input.image = { src: collection.image_url.trim() };

        let col;
        try {
          col = await gqlCollectionCreate(input);
        } catch (imgErr) {
          if (hasImage) {
            // Retry without image
            delete input.image;
            col = await gqlCollectionCreate(input);
            results.push({ row: i + 1, title: collection.title, status: "success", collectionId: col.id.split("/").pop(), type: "custom", warning: "Collection imported without image - URL not accessible" });
            successCount++;
            continue;
          }
          throw imgErr;
        }
        results.push({ row: i + 1, title: collection.title, status: "success", collectionId: col.id.split("/").pop(), type: "custom" });
        successCount++;
      }
    } catch (error) {
      results.push({ row: i + 1, title: collection.title || "Unknown", status: "error", error: error.message });
      errorCount++;
    }
  }

  const status = errorCount === 0 ? "completed" : successCount === 0 ? "failed" : "completed_with_errors";

  await prisma.importJob.create({
    data: {
      shop: session.shop,
      fileName,
      totalRows: collections.length,
      successCount,
      errorCount,
      status,
      results: JSON.stringify(results),
      importType: "collections",
    },
  });

  return { results, successCount, errorCount, status };
};

const STEP_UPLOAD = 0, STEP_MAP = 1, STEP_PREVIEW = 2, STEP_IMPORTING = 3, STEP_RESULTS = 4;

export default function CollectionsImportPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const fileInputRef = useRef(null);
  const [step, setStep] = useState(STEP_UPLOAD);
  const [fileName, setFileName] = useState("");
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [confidence, setConfidence] = useState({});
  const [confirmed, setConfirmed] = useState(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importData, setImportData] = useState(null);

  const isProcessing = ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  useEffect(() => {
    if (!isProcessing) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isProcessing]);

  useEffect(() => {
    if (fetcher.data?.results) {
      setImportData(fetcher.data);
      setStep(STEP_RESULTS);
      const { successCount, errorCount, status } = fetcher.data;
      shopify.toast.show(status === "completed" ? `Imported ${successCount} collections` : `${successCount} imported, ${errorCount} failed`, { isError: status !== "completed" });
    }
  }, [fetcher.data, shopify]);

  const handleFile = useCallback((file) => {
    if (!file || !file.name.endsWith(".csv")) { shopify.toast.show("Please upload a CSV file", { isError: true }); return; }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      if (rows.length < 2) { shopify.toast.show("CSV must have a header and data rows", { isError: true }); return; }
      const headers = rows[0];
      const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim()));
      setCsvHeaders(headers);
      setCsvRows(dataRows);
      const { mapping: detectedMapping, confidence: detectedConfidence } = autoDetectMapping(headers, dataRows);
      setMapping(detectedMapping);
      setConfidence(detectedConfidence);
      shopify.toast.show("Columns auto-mapped.");
      setStep(STEP_MAP);
    };
    reader.readAsText(file);
  }, [shopify]);

  const handleDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }, [handleFile]);

  const getCollections = useCallback(() => {
    return csvRows.map((row) => {
      const obj = {};
      Object.entries(mapping).forEach(([ci, field]) => { if (field && row[ci] !== undefined) obj[field] = (row[ci] || "").trim(); });
      return obj;
    });
  }, [csvRows, mapping]);

  const doImport = useCallback(() => {
    const cols = getCollections();
    setStep(STEP_IMPORTING);
    const formData = new FormData();
    formData.append("collections", JSON.stringify(cols));
    formData.append("fileName", fileName);
    fetcher.submit(formData, { method: "POST" });
  }, [getCollections, fileName, fetcher]);

  const resetImport = useCallback(() => {
    setStep(STEP_UPLOAD); setFileName(""); setCsvHeaders([]); setCsvRows([]); setMapping({}); setConfidence({}); setConfirmed(new Set()); setShowAdvanced(false); setImportData(null);
  }, []);

  const hasTitleMapped = Object.values(mapping).includes("title");
  const collections = step >= STEP_PREVIEW ? getCollections() : [];
  const primary = "#17320A";

  return (
    <s-page heading="Collection Importer" subtitle={["Upload", "Map", "Preview", "Importing", "Results"][step]} backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: "#17320A", fontFamily: "'ImportzoFont', sans-serif" }}>Collection Importer</span>
        </div>

        {/* Step Indicator */}
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between max-w-xl mx-auto">
            {["Upload", "Map", "Preview", "Import"].map((label, i) => (
              <div key={label} className="flex items-center flex-1 last:flex-initial">
                <div className="flex flex-col items-center gap-1.5">
                  <div style={{
                    width: 36, height: 36, minWidth: 36, minHeight: 36, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600,
                    ...(i < step && i < 3 ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" }
                      : i === step || (step >= STEP_IMPORTING && i === 3) ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" }
                        : { background: "#E5E7EB", color: "#6b7280" }),
                  }}>
                    {i < step && i < 3 ? <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> : i + 1}
                  </div>
                  <span className={`text-xs font-medium hidden sm:block ${i === step ? "text-gray-900" : "text-gray-400"}`}>{label}</span>
                </div>
                {i < 3 && <div style={{ flex: 1, height: 2, marginLeft: 12, marginRight: 12, borderRadius: 1, background: i < step ? primary : "#e5e7eb" }} />}
              </div>
            ))}
          </div>
        </div>

        {/* UPLOAD */}
        {step === STEP_UPLOAD && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-6">Upload your collections CSV file</h2>
              <div
                role="button"
                tabIndex={0}
                className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-all ${dragOver ? "border-green-800 bg-green-50/50" : "border-gray-300 hover:border-gray-400 hover:bg-gray-50/50"}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
              >
                <div className="flex flex-col items-center gap-4">
                  <div style={{ width: 64, height: 64, borderRadius: "50%" }} className={`flex items-center justify-center ${dragOver ? "bg-green-100" : "bg-gray-100"}`}>
                    <svg width="32" height="32" className={dragOver ? "text-green-800" : "text-gray-400"} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                  </div>
                  <p className="text-base font-medium text-gray-700">Drag and drop your CSV file here</p>
                  <p className="text-sm text-gray-500">or click to browse files</p>
                </div>
                <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
              </div>
              <p className="text-sm text-gray-500 mt-4">
                Fields: Title, Body HTML, Image URL, Sort Order, Published, Collection Type (custom/smart), Smart Rules.
                Default type is &quot;custom&quot; (manual collection).
              </p>
            </div>
            <FileSourcePicker onFileSelected={handleFile} accept=".csv" />
          </div>
        )}

        {/* MAP */}
        {step === STEP_MAP && (
          <div className="animate-fade-in space-y-4">
            {!hasTitleMapped && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-3">
                <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                <span className="text-sm font-medium text-amber-800">Please map at least the Title column.</span>
              </div>
            )}
            {(() => {
              const s = generateMappingSummary(csvHeaders, mapping, confidence, confirmed, ["title"]);
              return <AISummary icon="🧠" title="Smart Mapping Summary" items={s.items} variant={s.variant} />;
            })()}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">Map CSV Columns</h2>
                <p className="text-sm text-gray-500 mt-1">{csvRows.length} rows in <span className="font-medium text-gray-700">{fileName}</span></p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead><tr className="bg-gray-50/80">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">CSV Column</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Shopify Field</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {csvHeaders.map((header, i) => {
                      const conf = confidence[i] || 0;
                      const level = confidenceLevel(conf);
                      const isMapped = !!mapping[i];
                      const isConfirmed = confirmed.has(i);
                      const isRequired = !isMapped && header.toLowerCase().includes("title");
                      let statusLabel, statusClasses;
                      if (isConfirmed) { statusLabel = "Confirmed"; statusClasses = "bg-blue-50 text-blue-700 border-blue-200"; }
                      else if (isMapped && level === "high") { statusLabel = "Auto-mapped"; statusClasses = "bg-green-50 text-green-700 border-green-200"; }
                      else if (isMapped && (level === "medium" || level === "low")) { statusLabel = "Needs review"; statusClasses = "bg-amber-50 text-amber-700 border-amber-200"; }
                      else if (isRequired) { statusLabel = "Missing required field"; statusClasses = "bg-red-50 text-red-700 border-red-200"; }
                      else { statusLabel = null; }
                      return (
                        <tr key={i} className="hover:bg-gray-50/50">
                          <td className="px-6 py-3">
                            <span className="text-sm font-medium text-gray-900">{header}</span>
                            <span className="block text-xs text-gray-400 truncate max-w-[180px]">{csvRows[0]?.[i] || ""}</span>
                          </td>
                          <td className="px-6 py-3">
                            <select value={mapping[i] || ""} onChange={(e) => { setMapping((p) => ({ ...p, [i]: e.target.value })); setConfidence((p) => ({ ...p, [i]: e.target.value ? 100 : 0 })); setConfirmed((p) => { const n = new Set(p); if (e.target.value) n.add(i); else n.delete(i); return n; }); }}
                              className={`w-full max-w-[220px] px-3 py-1.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-green-800/20 ${mapping[i] ? "border-green-800 bg-green-50 text-green-900 font-medium" : "border-gray-300 bg-white text-gray-600"}`}>
                              {COLLECTION_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </select>
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
              <div className="border-t border-gray-100">
                <button onClick={() => setShowAdvanced((p) => !p)} className="w-full px-6 py-3 flex items-center justify-between text-left hover:bg-gray-50/50 transition-colors">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Advanced details</span>
                  <svg className={`w-4 h-4 text-gray-400 transition-transform ${showAdvanced ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {showAdvanced && (
                  <div className="px-6 pb-4">
                    <table className="w-full text-xs">
                      <thead><tr className="text-gray-400"><th className="text-left py-1 font-medium">Column</th><th className="text-left py-1 font-medium">Mapped To</th><th className="text-left py-1 font-medium">Confidence</th><th className="text-left py-1 font-medium">Source</th></tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {csvHeaders.map((header, i) => {
                          const conf = confidence[i] || 0;
                          const colors = confidenceColor(confidenceLevel(conf));
                          return (
                            <tr key={i}>
                              <td className="py-1.5 text-gray-600">{header}</td>
                              <td className="py-1.5 text-gray-800 font-medium">{mapping[i] ? COLLECTION_FIELDS.find((f) => f.value === mapping[i])?.label || mapping[i] : "—"}</td>
                              <td className="py-1.5">{mapping[i] ? <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} ${colors.text}`}>{conf}%</span> : "—"}</td>
                              <td className="py-1.5 text-gray-500">{confirmed.has(i) ? "Manual" : mapping[i] ? "Auto" : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_UPLOAD)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={() => setStep(STEP_PREVIEW)} disabled={!hasTitleMapped}
                style={hasTitleMapped ? { background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: "'ImportzoFont', sans-serif" } : { borderRadius: 8 }}
                className={`px-5 py-2 text-sm rounded-lg transition-all ${hasTitleMapped ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                Preview Collections
              </button>
            </div>
          </div>
        )}

        {/* PREVIEW */}
        {step === STEP_PREVIEW && (
          <div className="animate-fade-in space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">Preview</h2>
                <p className="text-sm text-gray-500 mt-0.5">{collections.length} collection{collections.length !== 1 ? "s" : ""} ready</p>
              </div>
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full">
                  <thead><tr className="bg-gray-50/80 sticky top-0 z-10">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">#</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Title</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Type</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Published</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Details</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {collections.slice(0, 50).map((c, i) => (
                      <tr key={i} className="hover:bg-gray-50/50">
                        <td className="px-6 py-3 text-sm text-gray-400 font-mono">{i + 1}</td>
                        <td className="px-6 py-3 text-sm font-medium text-gray-900">{c.title || "\u2014"}</td>
                        <td className="px-6 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${(c.collection_type || "").toLowerCase() === "smart" ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"}`}>
                            {(c.collection_type || "custom").toLowerCase() === "smart" ? "Smart" : "Custom"}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-600">{c.published || "\u2014"}</td>
                        <td className="px-6 py-3 text-xs text-gray-500 max-w-[200px] truncate">{c.body_html ? "Has description" : "\u2014"}{c.image_url ? " \u00b7 Has image" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_MAP)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={doImport} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: "'ImportzoFont', sans-serif" }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]">
                Import {collections.length} Collection{collections.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* IMPORTING */}
        {step === STEP_IMPORTING && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-8 sm:p-10 shadow-sm">
              <div className="flex flex-col items-center gap-6 max-w-md mx-auto">
                <div style={{ width: 64, height: 64, borderRadius: "50%" }} className="flex items-center justify-center bg-green-50">
                  <svg width="32" height="32" className="animate-spin" style={{ color: primary }} fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-gray-900">Processing collections...</h3>
                  <p className="text-sm text-gray-500 mt-2">Do not close this page. This may take a moment.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {step === STEP_RESULTS && importData && (
          <div className="animate-fade-in space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-green-200 p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center"><svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                  <div><p className="text-2xl font-bold text-gray-900">{importData.successCount}</p><p className="text-sm text-green-600 font-medium">Imported</p></div>
                </div>
              </div>
              {importData.errorCount > 0 && (
                <div className="bg-white rounded-xl border border-red-200 p-6 shadow-sm">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center"><svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                    <div><p className="text-2xl font-bold text-gray-900">{importData.errorCount}</p><p className="text-sm text-red-600 font-medium">Failed</p></div>
                  </div>
                </div>
              )}
            </div>
            {(() => {
              const s = generateImportResultSummary(importData.successCount, importData.errorCount, csvRows.length, "collection");
              return <AISummary icon="📊" title="Import Summary" items={s.items} variant={s.variant} />;
            })()}
            {importData.errorCount > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-900">Errors ({importData.errorCount})</h3></div>
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full">
                    <thead><tr className="bg-red-50/50"><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">#</th><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Collection</th><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Error</th></tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {importData.results.filter((r) => r.status === "error").map((r) => (
                        <tr key={r.row}><td className="px-6 py-2.5 text-sm text-gray-500">{r.row}</td><td className="px-6 py-2.5 text-sm font-medium text-gray-900">{r.title}</td><td className="px-6 py-2.5 text-sm text-red-600 break-words">{r.error}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {importData.successCount > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-900">Imported ({importData.successCount})</h3></div>
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full">
                    <thead><tr className="bg-gray-50/80"><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">#</th><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Collection</th><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Type</th><th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">ID</th></tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {importData.results.filter((r) => r.status === "success").map((r) => (
                        <tr key={r.row} className="hover:bg-gray-50/50">
                          <td className="px-6 py-2.5 text-sm text-gray-500">{r.row}</td>
                          <td className="px-6 py-2.5 text-sm font-medium text-gray-900">{r.title}</td>
                          <td className="px-6 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r.type === "smart" ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"}`}>{r.type || "custom"}</span></td>
                          <td className="px-6 py-2.5 text-sm text-gray-500 font-mono">{r.collectionId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <button onClick={resetImport} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: "'ImportzoFont', sans-serif" }} className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all">New Import</button>
              <Link to="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Dashboard</Link>
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
      heading="Import Collections"
      title="We couldn't load the Collection Importer"
      message="Please try again. Your CSV and existing collections are untouched."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
