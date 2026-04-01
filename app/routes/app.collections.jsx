import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = text.split("\n")[0] || "";
  let delimiter = ",";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (let c = 0; c < firstLine.length; c++) {
    if (firstLine[c] === '"') q = !q;
    if (!q && counts[firstLine[c]] !== undefined) counts[firstLine[c]]++;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) delimiter = "\t";
  else if (counts[";"] > counts[","] && counts[";"] > counts["\t"]) delimiter = ";";
  const rows = [];
  let fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (inQuotes && text[i + 1] === '"') { current += '"'; i++; } else inQuotes = !inQuotes; }
    else if (char === delimiter && !inQuotes) { fields.push(current.trim()); current = ""; }
    else if (char === "\n" && !inQuotes) { fields.push(current.trim()); current = ""; if (fields.some((f) => f !== "")) rows.push(fields); fields = []; }
    else current += char;
  }
  if (current || fields.length > 0) { fields.push(current.trim()); if (fields.some((f) => f !== "")) rows.push(fields); }
  return rows;
}

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

function similarity(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  b = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const triA = new Set(), triB = new Set();
  for (let i = 0; i <= a.length - 2; i++) triA.add(a.slice(i, i + 2));
  for (let i = 0; i <= b.length - 2; i++) triB.add(b.slice(i, i + 2));
  if (triA.size === 0 || triB.size === 0) return 0;
  let inter = 0;
  for (const t of triA) if (triB.has(t)) inter++;
  return inter / Math.max(triA.size, triB.size);
}

function autoDetectMapping(headers) {
  const mapping = {};
  const confidence = {};
  const patterns = {
    title: ["title", "name", "collectionname", "collectiontitle"],
    body_html: ["bodyhtml", "body", "description", "desc", "html"],
    image_url: ["image", "imageurl", "imagesrc", "img", "photo", "thumbnail"],
    sort_order: ["sortorder", "sort", "order", "ordering"],
    published: ["published", "status", "active", "visible"],
    collection_type: ["type", "collectiontype", "kind"],
    rules_column: ["rules", "smartrules", "conditions", "rule"],
  };
  const usedFields = new Set();
  headers.forEach((header, index) => {
    let bestField = "";
    let bestScore = 0;
    const norm = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const [field, aliases] of Object.entries(patterns)) {
      if (usedFields.has(field)) continue;
      for (const alias of aliases) {
        const score = similarity(norm, alias);
        if (score > bestScore) { bestScore = score; bestField = field; }
      }
    }
    if (bestScore >= 0.6) {
      mapping[index] = bestField;
      confidence[index] = Math.round(bestScore * 100);
      usedFields.add(bestField);
    } else {
      mapping[index] = "";
      confidence[index] = 0;
    }
  });
  return { mapping, confidence };
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const collections = JSON.parse(formData.get("collections") || "[]");
  const fileName = formData.get("fileName") || "collections.csv";
  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";

  const results = [];
  let successCount = 0, errorCount = 0;

  for (let i = 0; i < collections.length; i++) {
    const collection = collections[i];
    const isSmartType = (collection.collection_type || "").toLowerCase() === "smart";

    try {
      if (isSmartType) {
        // Smart collection
        const smartData = { title: collection.title || "Untitled Collection" };
        if (collection.body_html) smartData.body_html = collection.body_html;
        if (collection.published !== undefined && collection.published !== "") {
          smartData.published = ["true", "yes", "1"].includes(collection.published.toLowerCase());
        }
        if (collection.sort_order) smartData.sort_order = collection.sort_order;

        // Parse rules: format "column:relation:condition" separated by |
        const rules = [];
        if (collection.rules_column) {
          collection.rules_column.split("|").forEach((r) => {
            const parts = r.trim().split(":");
            if (parts.length >= 3) {
              rules.push({ column: parts[0].trim(), relation: parts[1].trim(), condition: parts.slice(2).join(":").trim() });
            }
          });
        }
        if (rules.length === 0) {
          rules.push({ column: "tag", relation: "equals", condition: collection.title || "imported" });
        }
        smartData.rules = rules;

        const response = await fetch(
          `https://${shopDomain}/admin/api/${version}/smart_collections.json`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({ smart_collection: smartData }),
          }
        );
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.errors ? (typeof err.errors === "string" ? err.errors : JSON.stringify(err.errors)) : `HTTP ${response.status}`);
        }
        const data = await response.json();
        results.push({ row: i + 1, title: collection.title, status: "success", collectionId: data.smart_collection.id, type: "smart" });
        successCount++;
      } else {
        // Custom (manual) collection
        const customData = { title: collection.title || "Untitled Collection" };
        if (collection.body_html) customData.body_html = collection.body_html;
        if (collection.published !== undefined && collection.published !== "") {
          customData.published = ["true", "yes", "1"].includes(collection.published.toLowerCase());
        }
        if (collection.sort_order) customData.sort_order = collection.sort_order;
        const hasImage = collection.image_url && /^https?:\/\//i.test(collection.image_url.trim());
        if (hasImage) {
          customData.image = { src: collection.image_url.trim() };
        }

        let response = await fetch(
          `https://${shopDomain}/admin/api/${version}/custom_collections.json`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({ custom_collection: customData }),
          }
        );

        // If failed and had an image, retry without image
        if (!response.ok && hasImage) {
          delete customData.image;
          response = await fetch(
            `https://${shopDomain}/admin/api/${version}/custom_collections.json`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
              body: JSON.stringify({ custom_collection: customData }),
            }
          );
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.errors ? (typeof err.errors === "string" ? err.errors : JSON.stringify(err.errors)) : `HTTP ${response.status}`);
          }
          const data = await response.json();
          results.push({ row: i + 1, title: collection.title, status: "success", collectionId: data.custom_collection.id, type: "custom", warning: "Collection imported without image - URL not accessible" });
          successCount++;
        } else if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.errors ? (typeof err.errors === "string" ? err.errors : JSON.stringify(err.errors)) : `HTTP ${response.status}`);
        } else {
          const data = await response.json();
          results.push({ row: i + 1, title: collection.title, status: "success", collectionId: data.custom_collection.id, type: "custom" });
          successCount++;
        }
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
      setCsvHeaders(rows[0]);
      setCsvRows(rows.slice(1).filter((r) => r.some((c) => c.trim())));
      const detected = autoDetectMapping(rows[0]);
      setMapping(detected.mapping);
      setConfidence(detected.confidence);
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
    setStep(STEP_UPLOAD); setFileName(""); setCsvHeaders([]); setCsvRows([]); setMapping({}); setConfidence({}); setImportData(null);
  }, []);

  const hasTitleMapped = Object.values(mapping).includes("title");
  const collections = step >= STEP_PREVIEW ? getCollections() : [];
  const primary = "#17320A";
  const secondary = "#2E6316";

  const confidenceColor = (score) => {
    if (score >= 80) return { bg: "bg-green-50", border: "border-green-300", text: "text-green-700" };
    if (score >= 50) return { bg: "bg-yellow-50", border: "border-yellow-300", text: "text-yellow-700" };
    return { bg: "bg-red-50", border: "border-red-300", text: "text-red-700" };
  };

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
                className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-all ${dragOver ? "border-green-800 bg-green-50/50" : "border-gray-300 hover:border-gray-400 hover:bg-gray-50/50"}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
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
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">Map CSV Columns</h2>
                <p className="text-sm text-gray-500 mt-1">{csvRows.length} rows in <span className="font-medium text-gray-700">{fileName}</span></p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead><tr className="bg-gray-50/80">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">CSV Column</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Sample</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Shopify Field</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Confidence</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {csvHeaders.map((header, i) => {
                      const conf = confidence[i] || 0;
                      const colors = confidenceColor(conf);
                      return (
                        <tr key={i} className="hover:bg-gray-50/50">
                          <td className="px-6 py-3"><span className="text-sm font-medium text-gray-900">{header}</span></td>
                          <td className="px-6 py-3 max-w-[200px]"><span className="text-sm text-gray-500 truncate block">{csvRows[0]?.[i] || "\u2014"}</span></td>
                          <td className="px-6 py-3">
                            <select value={mapping[i] || ""} onChange={(e) => { setMapping((p) => ({ ...p, [i]: e.target.value })); setConfidence((p) => ({ ...p, [i]: e.target.value ? 100 : 0 })); }}
                              className={`w-full max-w-[220px] px-3 py-1.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-green-800/20 ${mapping[i] ? "border-green-800 bg-green-50 text-green-900 font-medium" : "border-gray-300 bg-white text-gray-600"}`}>
                              {COLLECTION_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </select>
                          </td>
                          <td className="px-6 py-3">
                            {mapping[i] ? <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text} border ${colors.border}`}>{conf}%</span> : <span className="text-xs text-gray-400">&mdash;</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
              <a href="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Dashboard</a>
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
