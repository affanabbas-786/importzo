import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { parseCSV } from "../lib/csv-parser";
import { smartMapColumns, INVENTORY_ALIASES, confidenceLevel, confidenceColor } from "../lib/smart-mapper";
import { FileSourcePicker, AISummary, generateMappingSummary, generateImportResultSummary } from "../components/ui";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

const INVENTORY_FIELDS = [
  { value: "", label: "-- Skip --" },
  { value: "sku", label: "SKU" },
  { value: "location", label: "Location Name" },
  { value: "quantity", label: "Quantity / Available" },
];

function autoDetectMapping(headers, dataRows) {
  return smartMapColumns(headers, dataRows || [], INVENTORY_ALIASES);
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";
  const authHeaders = { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken };

  const items = JSON.parse(formData.get("items") || "[]");
  const fileName = formData.get("fileName") || "inventory.csv";

  // Fetch locations
  const locMap = {};
  const locRes = await fetch(`https://${shopDomain}/admin/api/${version}/locations.json`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  const locData = await locRes.json();
  (locData.locations || []).forEach((loc) => {
    locMap[loc.name.toLowerCase()] = `gid://shopify/Location/${loc.id}`;
  });

  const results = [];
  let updatedCount = 0, notFoundCount = 0, errorCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // Look up variant by SKU using GraphQL
      const gqlRes = await fetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          query: `{
            productVariants(first: 1, query: "sku:${item.sku.replace(/"/g, '\\"')}") {
              edges {
                node {
                  id
                  sku
                  inventoryItem { id }
                }
              }
            }
          }`,
        }),
      });
      const gqlData = await gqlRes.json();
      const variant = gqlData?.data?.productVariants?.edges?.[0]?.node;

      if (!variant) {
        results.push({ row: i + 1, sku: item.sku, status: "not_found", error: "SKU not found in store" });
        notFoundCount++;
        continue;
      }

      const inventoryItemId = variant.inventoryItem.id;
      const qty = parseInt(item.quantity || "0", 10);

      // Determine location ID
      let locationId = null;
      if (item.location && locMap[item.location.toLowerCase()]) {
        locationId = locMap[item.location.toLowerCase()];
      } else {
        // Use first/default location
        const locKeys = Object.values(locMap);
        if (locKeys.length > 0) locationId = locKeys[0];
      }

      if (!locationId) {
        throw new Error("No location found");
      }

      // Set inventory level using GraphQL
      const setRes = await fetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          query: `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup { reason }
              userErrors { field message }
            }
          }`,
          variables: {
            input: {
              reason: "correction",
              name: "available",
              quantities: [{
                inventoryItemId,
                locationId: locationId.startsWith("gid://") ? locationId : `gid://shopify/Location/${locationId}`,
                quantity: qty,
              }],
            },
          },
        }),
      });

      const setData = await setRes.json();
      const userErrors = setData?.data?.inventorySetQuantities?.userErrors;
      if (userErrors && userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }

      results.push({ row: i + 1, sku: item.sku, status: "updated", quantity: qty });
      updatedCount++;
    } catch (error) {
      results.push({ row: i + 1, sku: item.sku, status: "error", error: error.message });
      errorCount++;
    }
  }

  const status = errorCount === 0 && notFoundCount === 0 ? "completed" : updatedCount === 0 ? "failed" : "completed_with_errors";

  await prisma.importJob.create({
    data: {
      shop: session.shop,
      fileName,
      totalRows: items.length,
      successCount: updatedCount,
      errorCount: errorCount + notFoundCount,
      status,
      results: JSON.stringify(results),
      importType: "inventory",
    },
  });

  return { results, updatedCount, notFoundCount, errorCount, status };
};

const STEP_UPLOAD = 0, STEP_MAP = 1, STEP_PREVIEW = 2, STEP_UPDATING = 3, STEP_RESULTS = 4;

export default function InventoryUpdatePage() {
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
  const [updateData, setUpdateData] = useState(null);

  const isProcessing = ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  useEffect(() => {
    if (!isProcessing) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isProcessing]);

  useEffect(() => {
    if (fetcher.data?.results) {
      setUpdateData(fetcher.data);
      setStep(STEP_RESULTS);
      shopify.toast.show(`Updated ${fetcher.data.updatedCount}, ${fetcher.data.notFoundCount} not found, ${fetcher.data.errorCount} errors`);
    }
  }, [fetcher.data, shopify]);

  const handleFile = useCallback((file) => {
    if (!file || !file.name.endsWith(".csv")) { shopify.toast.show("Please upload a CSV file", { isError: true }); return; }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      if (rows.length < 2) { shopify.toast.show("Need header + data rows", { isError: true }); return; }
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

  const getItems = useCallback(() => {
    return csvRows.map((row) => {
      const obj = {};
      Object.entries(mapping).forEach(([ci, field]) => { if (field && row[ci] !== undefined) obj[field] = (row[ci] || "").trim(); });
      return obj;
    }).filter((item) => item.sku);
  }, [csvRows, mapping]);

  const doUpdate = useCallback(() => {
    const items = getItems();
    setStep(STEP_UPDATING);
    const formData = new FormData();
    formData.append("items", JSON.stringify(items));
    formData.append("fileName", fileName);
    fetcher.submit(formData, { method: "POST" });
  }, [getItems, fileName, fetcher]);

  const resetUpdate = useCallback(() => {
    setStep(STEP_UPLOAD); setFileName(""); setCsvHeaders([]); setCsvRows([]); setMapping({}); setConfidence({}); setConfirmed(new Set()); setShowAdvanced(false); setUpdateData(null);
  }, []);

  const hasSkuMapped = Object.values(mapping).includes("sku");
  const hasQtyMapped = Object.values(mapping).includes("quantity");
  const canProceed = hasSkuMapped && hasQtyMapped;
  const items = step >= STEP_PREVIEW ? getItems() : [];
  const primary = "#17320A";

  return (
    <s-page heading="Inventory Update" subtitle={["Upload", "Map", "Preview", "Updating", "Results"][step]} backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: "#17320A", fontFamily: "'ImportzoFont', sans-serif" }}>Inventory Update</span>
        </div>

        {/* Info Banner */}
        {step === STEP_UPLOAD && (
          <div className="rounded-lg px-4 py-3 flex items-center gap-3" style={{ background: "rgba(23,50,10,0.08)", border: "1px solid rgba(23,50,10,0.25)" }}>
            <svg className="w-5 h-5 flex-shrink-0" style={{ color: primary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium" style={{ color: "#17320A" }}>
              This tool updates inventory quantities for existing products by SKU. No new products will be created.
            </span>
          </div>
        )}

        {/* Step Indicator */}
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between max-w-xl mx-auto">
            {["Upload", "Map", "Preview", "Update"].map((label, i) => (
              <div key={label} className="flex items-center flex-1 last:flex-initial">
                <div className="flex flex-col items-center gap-1.5">
                  <div style={{
                    width: 36, height: 36, minWidth: 36, minHeight: 36, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600,
                    ...(i < step && i < 3 ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" }
                      : i === step || (step >= STEP_UPDATING && i === 3) ? { background: primary, color: "white", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" }
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
              <h2 className="text-lg font-semibold text-gray-900 mb-6">Upload inventory CSV</h2>
              <div
                className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-all ${dragOver ? "border-green-800 bg-green-50/50" : "border-gray-300 hover:border-gray-400 hover:bg-gray-50/50"}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
              >
                <div className="flex flex-col items-center gap-4">
                  <div style={{ width: 64, height: 64, borderRadius: "50%" }} className={`flex items-center justify-center ${dragOver ? "bg-green-100" : "bg-gray-100"}`}>
                    <svg width="32" height="32" className={dragOver ? "text-green-800" : "text-gray-400"} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                  </div>
                  <p className="text-base font-medium text-gray-700">Drag and drop your CSV file here</p>
                  <p className="text-sm text-gray-500">or click to browse</p>
                </div>
                <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
              </div>
              <p className="text-sm text-gray-500 mt-4">Required: SKU and Quantity. Optional: Location Name (defaults to primary location).</p>
            </div>
            <FileSourcePicker onFileSelected={handleFile} accept=".csv" />
          </div>
        )}

        {/* MAP */}
        {step === STEP_MAP && (
          <div className="animate-fade-in space-y-4">
            {!canProceed && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-3">
                <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                <span className="text-sm font-medium text-amber-800">Please map both SKU and Quantity columns.</span>
              </div>
            )}
            {(() => {
              const s = generateMappingSummary(csvHeaders, mapping, confidence, confirmed, ["sku", "quantity"]);
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
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">CSV Column</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Field</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Status</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {csvHeaders.map((header, i) => {
                      const conf = confidence[i] || 0;
                      const level = confidenceLevel(conf);
                      const isMapped = !!mapping[i];
                      const isConfirmed = confirmed.has(i);
                      const hl = header.toLowerCase();
                      const isRequired = !isMapped && (hl.includes("sku") || hl.includes("quantity") || hl.includes("available"));
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
                              {INVENTORY_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
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
                              <td className="py-1.5 text-gray-800 font-medium">{mapping[i] ? INVENTORY_FIELDS.find((f) => f.value === mapping[i])?.label || mapping[i] : "—"}</td>
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
              <button onClick={() => setStep(STEP_PREVIEW)} disabled={!canProceed}
                style={canProceed ? { background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: "'ImportzoFont', sans-serif" } : { borderRadius: 8 }}
                className={`px-5 py-2 text-sm rounded-lg transition-all ${canProceed ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}>
                Preview
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
                <p className="text-sm text-gray-500 mt-0.5">{items.length} SKU{items.length !== 1 ? "s" : ""} to update</p>
              </div>
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full">
                  <thead><tr className="bg-gray-50/80 sticky top-0 z-10">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">#</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">SKU</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Location</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Quantity</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.slice(0, 100).map((item, i) => (
                      <tr key={i} className="hover:bg-gray-50/50">
                        <td className="px-6 py-3 text-sm text-gray-400 font-mono">{i + 1}</td>
                        <td className="px-6 py-3 text-sm font-medium text-gray-900 font-mono">{item.sku}</td>
                        <td className="px-6 py-3 text-sm text-gray-600">{item.location || "Default"}</td>
                        <td className="px-6 py-3 text-sm font-medium text-gray-900">{item.quantity || "0"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {items.length > 100 && (
                <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50"><p className="text-xs text-gray-500">Showing first 100 of {items.length}</p></div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep(STEP_MAP)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
              <button onClick={doUpdate} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: "'ImportzoFont', sans-serif" }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98]">
                Update {items.length} SKU{items.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* UPDATING */}
        {step === STEP_UPDATING && (
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
                  <h3 className="text-lg font-semibold text-gray-900">Processing inventory updates...</h3>
                  <p className="text-sm text-gray-500 mt-2">Do not close this page. This may take a moment.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {step === STEP_RESULTS && updateData && (
          <div className="animate-fade-in space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-xl border border-green-200 p-5 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center"><svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                  <div><p className="text-2xl font-bold text-gray-900">{updateData.updatedCount}</p><p className="text-xs font-medium text-green-600 uppercase">Updated</p></div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-amber-200 p-5 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center"><svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                  <div><p className="text-2xl font-bold text-gray-900">{updateData.notFoundCount}</p><p className="text-xs font-medium text-amber-600 uppercase">Not Found</p></div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-red-200 p-5 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center"><svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                  <div><p className="text-2xl font-bold text-gray-900">{updateData.errorCount}</p><p className="text-xs font-medium text-red-600 uppercase">Errors</p></div>
                </div>
              </div>
            </div>

            {(() => {
              const s = generateImportResultSummary(updateData.updatedCount, updateData.errorCount + updateData.notFoundCount, csvRows.length, "inventory item");
              return <AISummary icon="📊" title="Update Summary" items={s.items} variant={s.variant} />;
            })()}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-900">All Results</h3></div>
              <div className="overflow-auto max-h-[400px]">
                <table className="w-full">
                  <thead><tr className="bg-gray-50/80 sticky top-0 z-10">
                    <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">#</th>
                    <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">SKU</th>
                    <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Status</th>
                    <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">Details</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {updateData.results.map((r) => (
                      <tr key={r.row} className="hover:bg-gray-50/50">
                        <td className="px-6 py-2.5 text-sm text-gray-500">{r.row}</td>
                        <td className="px-6 py-2.5 text-sm font-medium text-gray-900 font-mono">{r.sku}</td>
                        <td className="px-6 py-2.5">
                          {r.status === "updated" && <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">Updated</span>}
                          {r.status === "not_found" && <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">Not Found</span>}
                          {r.status === "error" && <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700">Error</span>}
                        </td>
                        <td className="px-6 py-2.5 text-sm text-gray-500">
                          {r.status === "updated" && `Qty set to ${r.quantity}`}
                          {r.status === "not_found" && "SKU not found in store"}
                          {r.status === "error" && <span className="text-red-600">{r.error}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={resetUpdate} style={{ background: primary, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: "'ImportzoFont', sans-serif" }} className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all">New Update</button>
              <a href="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Dashboard</a>
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
      heading="Update Inventory"
      title="We couldn't load the Inventory Updater"
      message="Please try again. Your inventory data is unchanged — this is just a display issue."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
