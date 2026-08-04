import { useState, useCallback, useEffect, useRef } from "react";
import { useFetcher, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { ErrorBanner } from "../components/ui";
import { LeafIcon } from "../components/decor";

// ═══════════════════════════════════════════════════════════════════
// Server action
// ═══════════════════════════════════════════════════════════════════
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";
  const authHeaders = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };

  // 429 backoff now lives in the shared shopify-api.server.js helper (also
  // used by migration-worker.server.js and app.transfer.jsx). `timeoutMs`
  // preserves this route's original per-attempt 30s abort behavior.
  async function fetchAllGql(query, getPage) {
    const items = [];
    let after = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await shopifyGraphql(shopDomain, accessToken, query, { after }, version, { timeoutMs: 30000 });
      const page = getPage(data);
      if (!page) throw new Error("GraphQL returned no data");
      items.push(...(page?.edges || []).map((e) => e.node));
      after = page?.edges?.length ? page.edges[page.edges.length - 1].cursor : null;
      hasNextPage = !!page?.pageInfo?.hasNextPage;
    }
    return items;
  }

  function escapeCsv(val) {
    if (val === null || val === undefined) return "";
    const str = String(val);
    return (str.includes(",") || str.includes('"') || str.includes("\n")) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function toCsv(headers, rows) {
    const lines = [headers.map(escapeCsv).join(",")];
    for (const row of rows) lines.push(headers.map((h) => escapeCsv(row[h] ?? "")).join(","));
    return lines.join("\n");
  }

  try {
    // ── Counts ──
    if (intent === "counts") {
      const res = await fetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ query: `{ productsCount { count } collectionsCount { count } customersCount { count } }` }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      return Response.json({ intent: "counts", ok: true, products: data?.productsCount?.count || 0, collections: data?.collectionsCount?.count || 0, customers: data?.customersCount?.count || 0 });
    }

    // ── Export Products ──
    if (intent === "export-products") {
      const PRODUCT_QUERY = `query ExportProducts($after: String) {
        products(first: 250, after: $after) {
          edges { cursor node {
            handle title descriptionHtml vendor productType tags status
            options { name }
            images(first: 250) { edges { node { url } } }
            variants(first: 100) { edges { node {
              sku price compareAtPrice barcode inventoryQuantity
              inventoryItem { measurement { weight { value unit } } }
              selectedOptions { name value }
            } } }
          } }
          pageInfo { hasNextPage }
        }
      }`;
      const products = await fetchAllGql(PRODUCT_QUERY, (d) => d?.products);
      const rows = [];
      for (const p of products) {
        const variants = (p.variants?.edges || []).map((e) => e.node);
        const images = (p.images?.edges || []).map((e) => e.node?.url).filter(Boolean);
        const opts = p.options || [];
        for (let vi = 0; vi < Math.max(variants.length, 1); vi++) {
          const v = variants[vi] || {};
          const sel = v.selectedOptions || [];
          const w = v.inventoryItem?.measurement?.weight;
          rows.push({
            Handle: p.handle || "", Title: vi === 0 ? (p.title || "") : "",
            "Body (HTML)": vi === 0 ? (p.descriptionHtml || "") : "",
            Vendor: vi === 0 ? (p.vendor || "") : "",
            "Product Type": vi === 0 ? (p.productType || "") : "",
            Tags: vi === 0 ? (p.tags || []).join(", ") : "",
            Published: p.status === "ACTIVE" ? "TRUE" : "FALSE",
            "Option1 Name": sel[0] ? (opts[0]?.name || "Title") : "",
            "Option1 Value": sel[0]?.value || "",
            "Option2 Name": sel[1] ? (opts[1]?.name || "") : "",
            "Option2 Value": sel[1]?.value || "",
            "Option3 Name": sel[2] ? (opts[2]?.name || "") : "",
            "Option3 Value": sel[2]?.value || "",
            "Variant SKU": v.sku || "", "Variant Price": v.price || "",
            "Variant Compare At Price": v.compareAtPrice || "",
            "Variant Barcode": v.barcode || "",
            "Variant Inventory Qty": v.inventoryQuantity ?? "",
            "Variant Weight": w?.value ?? "", "Variant Weight Unit": w?.unit || "",
            "Image Src": vi === 0 && images[0] ? images[0] : (images[vi] || ""),
          });
        }
      }
      const csvH = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Type", "Tags", "Published", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value", "Variant SKU", "Variant Price", "Variant Compare At Price", "Variant Barcode", "Variant Inventory Qty", "Variant Weight", "Variant Weight Unit", "Image Src"];
      return Response.json({ intent: "export-products", ok: true, csv: toCsv(csvH, rows), filename: `products_${new Date().toISOString().slice(0, 10)}.csv`, count: products.length });
    }

    // ── Export Collections ──
    if (intent === "export-collections") {
      const COLLECTION_QUERY = `query ExportCollections($after: String) {
        collections(first: 250, after: $after) {
          edges { cursor node {
            handle title descriptionHtml sortOrder
            ruleSet { rules { column relation condition } }
            image { url }
          } }
          pageInfo { hasNextPage }
        }
      }`;
      const collections = await fetchAllGql(COLLECTION_QUERY, (d) => d?.collections);
      const rows = collections.map((c) => ({
        Title: c.title || "", Handle: c.handle || "", "Body HTML": c.descriptionHtml || "",
        Type: c.ruleSet ? "Smart" : "Custom",
        Published: "TRUE",
        "Sort Order": c.sortOrder || "", "Image Src": c.image?.url || "",
      }));
      const csvH = ["Title", "Handle", "Body HTML", "Type", "Published", "Sort Order", "Image Src"];
      return Response.json({ intent: "export-collections", ok: true, csv: toCsv(csvH, rows), filename: `collections_${new Date().toISOString().slice(0, 10)}.csv`, count: collections.length });
    }

    // ── Export Inventory ──
    if (intent === "export-inventory") {
      const INVENTORY_QUERY = `query ExportInventory($after: String) {
        products(first: 250, after: $after) {
          edges { cursor node {
            title
            variants(first: 100) { edges { node { sku price barcode inventoryQuantity title } } }
          } }
          pageInfo { hasNextPage }
        }
      }`;
      const products = await fetchAllGql(INVENTORY_QUERY, (d) => d?.products);
      const rows = [];
      for (const p of products) {
        for (const e of (p.variants?.edges || [])) {
          const v = e.node;
          if (v.sku) {
            rows.push({
              SKU: v.sku, "Product Title": p.title || "",
              "Variant Title": v.title || "Default Title",
              "Inventory Quantity": v.inventoryQuantity ?? 0,
              Price: v.price || "", Barcode: v.barcode || "",
            });
          }
        }
      }
      const csvH = ["SKU", "Product Title", "Variant Title", "Inventory Quantity", "Price", "Barcode"];
      return Response.json({ intent: "export-inventory", ok: true, csv: toCsv(csvH, rows), filename: `inventory_${new Date().toISOString().slice(0, 10)}.csv`, count: rows.length });
    }

    // ── Export Customers ──
    if (intent === "export-customers") {
      const CUSTOMER_QUERY = `query ExportCustomers($after: String) {
        customers(first: 250, after: $after) {
          edges { cursor node {
            firstName lastName email phone
            emailMarketingConsent { marketingState }
            numberOfOrders amountSpent { amount }
            tags note state
          } }
          pageInfo { hasNextPage }
        }
      }`;
      let customers;
      try {
        customers = await fetchAllGql(CUSTOMER_QUERY, (d) => d?.customers);
      } catch (err) {
        const msg = String(err.message || "").toLowerCase();
        if (msg.includes("access denied") || msg.includes("access_denied") || msg.includes("merchant approval") || msg.includes("not approved") || msg.includes("scope") || msg.includes("read_customers") || msg.includes("protected customer")) {
          return Response.json({
            intent: "export-customers",
            ok: false,
            error: "Customers export requires read_customers permission. Please grant the app access to customer data (Shopify protected customer data approval may also be required).",
          }, { status: 403 });
        }
        throw err;
      }
      const rows = customers.map((c) => ({
        "First Name": c.firstName || "",
        "Last Name": c.lastName || "",
        "Email": c.email || "",
        "Phone": c.phone || "",
        "Accepts Marketing": c.emailMarketingConsent?.marketingState === "SUBSCRIBED" ? "yes" : "no",
        "Orders Count": c.numberOfOrders ?? 0,
        "Total Spent": c.amountSpent?.amount || "0.00",
        "Tags": (c.tags || []).join(", "),
        "Note": c.note || "",
        "State": c.state || "",
      }));
      const csvH = ["First Name", "Last Name", "Email", "Phone", "Accepts Marketing", "Orders Count", "Total Spent", "Tags", "Note", "State"];
      return Response.json({ intent: "export-customers", ok: true, csv: toCsv(csvH, rows), filename: `customers_${new Date().toISOString().slice(0, 10)}.csv`, count: customers.length });
    }

    return Response.json({ intent, ok: false, error: "Unknown intent" }, { status: 400 });
  } catch (error) {
    return Response.json({ intent: intent ?? "", ok: false, error: error.message }, { status: 500 });
  }
};

// ═══════════════════════════════════════════════════════════════════
// Client
// ═══════════════════════════════════════════════════════════════════
const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";

const EXPORT_MODULES = {
  products:    { label: "Products",    desc: "All products with variants, images, pricing, and SKUs", intent: "export-products" },
  collections: { label: "Collections", desc: "Custom and smart collections with metadata",            intent: "export-collections" },
  inventory:   { label: "Inventory",   desc: "Stock quantities by SKU with pricing info",             intent: "export-inventory" },
  customers:   { label: "Customers",   desc: "Customer emails, names, phone numbers, and order data", intent: "export-customers" },
};

const MODULE_ICONS = {
  products:    "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  collections: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z",
  inventory:   "M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z",
  customers:   "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
};

const STEP_PREVIEW = 0;
const STEP_EXPORTING = 1;
const STEP_RESULTS = 2;

export default function ExportPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  // Hub vs flow state
  const [view, setView] = useState("hub");       // "hub" | "flow"
  const [exportMode, setExportMode] = useState(null); // "full" | module key
  const [step, setStep] = useState(STEP_PREVIEW);

  // Module selection (for full store export)
  const [selectedModules, setSelectedModules] = useState(new Set(Object.keys(EXPORT_MODULES)));

  // Counts from server
  const [counts, setCounts] = useState(null);

  // Export queue + results
  const exportQueueRef = useRef([]);
  const exportResultsRef = useRef({});
  const [exportResults, setExportResults] = useState({});
  const [currentExport, setCurrentExport] = useState(null);
  const [error, setError] = useState("");
  const [exportElapsed, setExportElapsed] = useState(0);
  const lastHandledData = useRef(null);

  const isBusy = fetcher.state !== "idle";

  // ── Start export flow ──
  const startFlow = useCallback((mode) => {
    setExportMode(mode);
    setView("flow");
    setStep(STEP_PREVIEW);
    setCounts(null);
    setError("");
    setExportResults({});
    exportResultsRef.current = {};
    lastHandledData.current = null;

    if (mode === "full") {
      setSelectedModules(new Set(Object.keys(EXPORT_MODULES)));
    } else {
      setSelectedModules(new Set([mode]));
    }

    // Fetch counts
    fetcher.submit({ intent: "counts" }, { method: "POST" });
  }, [fetcher]);

  const backToHub = useCallback(() => {
    setView("hub");
    setExportMode(null);
    setStep(STEP_PREVIEW);
    setCounts(null);
    setError("");
    setExportResults({});
    exportResultsRef.current = {};
    setCurrentExport(null);
    setExportElapsed(0);
  }, []);

  // Elapsed timer while exporting — shows "still working" for long jobs
  useEffect(() => {
    if (step !== STEP_EXPORTING) { setExportElapsed(0); return; }
    setExportElapsed(0);
    const id = setInterval(() => setExportElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [step]);

  // Safety valve: if fetcher stays busy for >150s in export mode, unblock UI.
  // The cleanup function clears this timeout if step changes before it fires.
  useEffect(() => {
    if (step !== STEP_EXPORTING) return;
    const safetyId = setTimeout(() => {
      setError("Export is taking longer than expected. Please try again or export in smaller batches.");
      setCurrentExport(null);
      setStep(STEP_RESULTS);
    }, 150000);
    return () => clearTimeout(safetyId);
  }, [step]);

  // ── Toggle module in full store export ──
  const toggleModule = useCallback((key) => {
    setSelectedModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // ── Begin exporting ──
  const startExport = useCallback(() => {
    const modules = [...selectedModules];
    if (modules.length === 0) return;

    setStep(STEP_EXPORTING);
    setError("");
    setExportResults({});
    exportResultsRef.current = {};
    lastHandledData.current = null;

    // Queue all but the first
    exportQueueRef.current = modules.slice(1);
    const first = modules[0];
    setCurrentExport(first);
    fetcher.submit({ intent: EXPORT_MODULES[first].intent }, { method: "POST" });
  }, [selectedModules, fetcher]);

  // ── Response handler ──
  useEffect(() => {
    // Surface unhandled server errors so the UI doesn't freeze
    if (fetcher.state !== "idle") return;
    if (fetcher.error && step === STEP_EXPORTING) {
      setError("Export failed: server error. Please try again.");
      setCurrentExport(null);
      setStep(STEP_RESULTS);
      return;
    }
    if (!fetcher.data) return;
    if (fetcher.data === lastHandledData.current) return;
    lastHandledData.current = fetcher.data;
    const d = fetcher.data;

    if (d.intent === "counts") {
      if (d.ok) setCounts({ products: d.products, collections: d.collections, customers: d.customers ?? 0 });
      else setError(d.error || "Failed to fetch counts");
      return;
    }

    // Export response
    if (d.intent && d.intent.startsWith("export-")) {
      const moduleKey = d.intent.replace("export-", "");
      const updated = { ...exportResultsRef.current, [moduleKey]: d };
      exportResultsRef.current = updated;
      setExportResults(updated);

      if (!d.ok) {
        setError(d.error || `Failed to export ${moduleKey}`);
      }

      if (d.ok && d.csv) {
        // Auto-download
        const blob = new Blob([d.csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = d.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      // Next in queue
      if (exportQueueRef.current.length > 0) {
        const next = exportQueueRef.current.shift();
        setCurrentExport(next);
        fetcher.submit({ intent: EXPORT_MODULES[next].intent }, { method: "POST" });
      } else {
        setCurrentExport(null);
        setStep(STEP_RESULTS);
        const hadErrors = Object.values({ ...exportResultsRef.current, [d.intent.replace("export-", "")]: d }).some((r) => !r.ok);
        shopify.toast.show(hadErrors ? "Export done with some errors" : "Export complete!");
      }
    }
  }, [fetcher.state, fetcher.data, fetcher.error, step, shopify, fetcher]);

  // ── Computed ──
  const totalExported = Object.values(exportResults).reduce((s, r) => s + (r.ok ? (r.count || 0) : 0), 0);
  const totalFiles = Object.values(exportResults).filter((r) => r.ok).length;
  const totalErrors = Object.values(exportResults).filter((r) => !r.ok).length;

  // ── Download a result again ──
  const redownload = useCallback((moduleKey) => {
    const r = exportResults[moduleKey];
    if (!r?.csv) return;
    const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [exportResults]);

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════
  return (
    <s-page heading="Export" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }} className="flex items-center gap-1.5">
            Export <LeafIcon size={14} />
          </span>
        </div>

        {/* ═══ HUB VIEW ═══ */}
        {view === "hub" && (
          <div className="animate-fade-in space-y-6">
            {/* Hero: Full Store Export */}
            <button
              onClick={() => startFlow("full")}
              className="group w-full text-left bg-white rounded-xl border-2 border-green-800/20 p-6 shadow-sm hover:shadow-lg hover:border-green-800/40 transition-all duration-200 hover:-translate-y-0.5"
              style={{ background: "linear-gradient(135deg, rgba(23,50,10,0.03) 0%, rgba(46,99,22,0.06) 100%)" }}
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: P, color: "#fff" }}>
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-gray-900" style={{ fontFamily: F }}>Full Store Export</h2>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider" style={{ background: "rgba(23,50,10,0.1)", color: S }}>Recommended</span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                    Export your entire store as CSV files. Products, collections, inventory, and customers &mdash; all at once.
                  </p>
                  <div className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold group-hover:gap-2.5 transition-all" style={{ color: S }}>
                    Start Full Export
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
                  </div>
                </div>
              </div>
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Or export selectively</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Selective Export Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(EXPORT_MODULES).map(([key, mod]) => (
                <button
                  key={key}
                  onClick={() => startFlow(key)}
                  className="group text-left bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5"
                >
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-3" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
                    <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={MODULE_ICONS[key]} />
                    </svg>
                  </div>
                  <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>Export {mod.label}</p>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">{mod.desc}</p>
                  <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold group-hover:gap-1.5 transition-all" style={{ color: S }}>
                    Export <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
                  </span>
                </button>
              ))}
            </div>

            {/* Not yet available — explained clearly */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-700">Pages, Blog Posts, Files and Metafields</p>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    CSV export for these content types isn&apos;t available yet. To migrate them between stores today,
                    use <Link to="/app/transfer" className="font-semibold hover:underline" style={{ color: S }}>Transfer Store</Link>, or use Shopify&apos;s admin
                    bulk actions. They&apos;ll appear here once we finalize a reliable field schema.
                  </p>
                </div>
              </div>
            </div>

            {/* Info */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-gray-700">About exports</p>
                  <p className="text-sm text-gray-500 mt-1">
                    All exports are downloaded as standard Shopify-compatible CSV files. Products include all variants and images.
                    Collections include both custom and smart types.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ FLOW VIEW ═══ */}
        {view === "flow" && (
          <div className="animate-fade-in space-y-5">
            {/* Stepper */}
            <div className="px-1 pb-2">
              <div className="flex items-center justify-between max-w-lg mx-auto">
                {["Preview", "Exporting", "Results"].map((label, i) => (
                  <div key={label} className="flex items-center flex-1 last:flex-initial">
                    <div className="flex flex-col items-center gap-1.5">
                      <div style={{
                        width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, fontWeight: 600,
                        ...(i <= step ? { background: P, color: "#fff", boxShadow: "0 4px 12px rgba(23,50,10,0.3)" } : { background: "#E5E7EB", color: "#6b7280" }),
                      }}>
                        {i < step ? <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> : i + 1}
                      </div>
                      <span className={`text-xs font-medium hidden sm:block ${i <= step ? "text-gray-900" : "text-gray-400"}`}>{label}</span>
                    </div>
                    {i < 2 && <div style={{ flex: 1, height: 2, marginLeft: 10, marginRight: 10, borderRadius: 1, background: i < step ? P : "#e5e7eb" }} />}
                  </div>
                ))}
              </div>
            </div>

            {/* Error — replaced raw red div with shared ErrorBanner (critical) */}
            {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}

            {/* ── STEP 0: PREVIEW ── */}
            {step === STEP_PREVIEW && (
              <div className="animate-fade-in space-y-4">
                <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                  <h3 className="text-base font-semibold text-gray-900 mb-1" style={{ fontFamily: F }}>
                    {exportMode === "full" ? "Full Store Export" : `Export ${EXPORT_MODULES[exportMode]?.label}`}
                  </h3>
                  <p className="text-sm text-gray-500 mb-5">
                    {exportMode === "full"
                      ? "Select the data you want to export. Each module will be saved as a separate CSV file."
                      : `This will export all ${EXPORT_MODULES[exportMode]?.label.toLowerCase()} from your store as a CSV file.`}
                  </p>

                  {/* Module checkboxes (full store only) */}
                  {exportMode === "full" && (
                    <div className="space-y-3 mb-5">
                      <div className="flex items-center gap-3">
                        <button onClick={() => setSelectedModules(new Set(Object.keys(EXPORT_MODULES)))} className="text-xs font-medium px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50" style={{ color: S }}>Select All</button>
                        <button onClick={() => setSelectedModules(new Set())} className="text-xs font-medium text-gray-500 px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50">Clear All</button>
                      </div>
                      {Object.entries(EXPORT_MODULES).map(([key, mod]) => (
                        <label key={key} className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${selectedModules.has(key) ? "border-green-200 bg-green-50/30" : "border-gray-200 bg-white"}`}>
                          <input type="checkbox" checked={selectedModules.has(key)} onChange={() => toggleModule(key)} className="w-4 h-4 rounded" style={{ accentColor: P }} />
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={MODULE_ICONS[key]} /></svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900">{mod.label}</p>
                            <p className="text-xs text-gray-500">{mod.desc}</p>
                          </div>
                          {counts && (
                            <span className="text-sm font-semibold text-gray-700 tabular-nums">
                              {key === "inventory" ? (counts.products ?? "—") : (counts[key] ?? "—")}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Single module count */}
                  {exportMode !== "full" && counts && (
                    <div className="mb-5 px-4 py-3 rounded-lg" style={{ background: "rgba(23,50,10,0.04)", border: "1px solid rgba(23,50,10,0.1)" }}>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={MODULE_ICONS[exportMode]} /></svg>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-900">
                            {exportMode === "inventory" ? counts.products : counts[exportMode]} {EXPORT_MODULES[exportMode]?.label.toLowerCase()}
                          </p>
                          <p className="text-xs text-gray-500">Will be exported as CSV</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Loading counts */}
                  {!counts && isBusy && (
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                      Loading store data...
                    </div>
                  )}

                  {/* Output details */}
                  <div className="text-xs text-gray-500 space-y-1 border-t border-gray-100 pt-4">
                    <p><strong>Format:</strong> CSV (comma-separated values)</p>
                    <p><strong>Files:</strong> {selectedModules.size} file{selectedModules.size !== 1 ? "s" : ""}</p>
                    <p><strong>Encoding:</strong> UTF-8</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3">
                  <button onClick={backToHub} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back</button>
                  <button
                    onClick={startExport}
                    disabled={selectedModules.size === 0 || isBusy}
                    style={selectedModules.size > 0 && !isBusy ? { background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F } : { borderRadius: 8 }}
                    className={`px-5 py-2.5 text-sm rounded-lg transition-all ${selectedModules.size > 0 && !isBusy ? "shadow-sm hover:brightness-110 active:scale-[0.98]" : "bg-gray-200 text-gray-400 cursor-not-allowed"}`}
                  >
                    Export {selectedModules.size} Module{selectedModules.size !== 1 ? "s" : ""}
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 1: EXPORTING ── */}
            {step === STEP_EXPORTING && (
              <div className="animate-fade-in">
                <div className="bg-white rounded-xl border border-gray-200 p-8 shadow-sm max-w-xl mx-auto">
                  <div className="flex flex-col items-center gap-5">
                    <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
                      <svg className="w-8 h-8 animate-spin" style={{ color: P }} fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                    <div className="text-center w-full">
                      <h3 className="text-lg font-semibold text-gray-900">Exporting store data...</h3>
                      <p className="text-sm text-gray-500 mt-1">
                        Files will download automatically as they complete.{exportElapsed > 0 ? ` · ${Math.floor(exportElapsed / 60)}m ${exportElapsed % 60}s` : ""}
                      </p>
                      {exportElapsed >= 45 && (
                        <p className="text-xs text-amber-600 mt-1">Large exports can take a while — still working.</p>
                      )}
                      {currentExport === "customers" && (
                        <p className="text-xs text-blue-600 mt-1">Customer export may take 1–2 min for large stores — fetching all pages.</p>
                      )}

                      {/* Progress */}
                      <div className="mt-6 space-y-2 text-left">
                        {[...selectedModules].map((key) => {
                          const result = exportResults[key];
                          const isCurrent = currentExport === key;
                          return (
                            <div key={key} className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-gray-50">
                              {result?.ok ? (
                                <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                              ) : result && !result.ok ? (
                                <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              ) : isCurrent ? (
                                <svg className="w-5 h-5 animate-spin flex-shrink-0" style={{ color: P }} fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                              ) : (
                                <div className="w-5 h-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                              )}
                              <span className={`text-sm font-medium flex-1 ${result?.ok ? "text-green-700" : result && !result.ok ? "text-red-700" : isCurrent ? "text-gray-900" : "text-gray-400"}`}>
                                {EXPORT_MODULES[key]?.label}
                              </span>
                              {result?.ok && <span className="text-xs text-gray-500">{result.count} records</span>}
                              {result && !result.ok && <span className="text-xs text-red-600">Failed</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── STEP 2: RESULTS ── */}
            {step === STEP_RESULTS && (
              <div className="animate-fade-in space-y-4">
                {/* Summary stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-white rounded-xl border border-green-200 p-5 shadow-sm">
                    <p className="text-2xl font-bold text-gray-900">{totalFiles}</p>
                    <p className="text-sm text-green-600 font-medium">Files Exported</p>
                  </div>
                  <div className="bg-white rounded-xl border border-green-200 p-5 shadow-sm">
                    <p className="text-2xl font-bold text-gray-900">{totalExported.toLocaleString()}</p>
                    <p className="text-sm text-green-600 font-medium">Total Records</p>
                  </div>
                  {totalErrors > 0 && (
                    <div className="bg-white rounded-xl border border-red-200 p-5 shadow-sm">
                      <p className="text-2xl font-bold text-gray-900">{totalErrors}</p>
                      <p className="text-sm text-red-600 font-medium">Failed Exports</p>
                    </div>
                  )}
                </div>

                {/* Per-module results */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100">
                    <h3 className="text-sm font-semibold text-gray-900">Export Results</h3>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {[...selectedModules].map((key) => {
                      const r = exportResults[key];
                      if (!r) return null;
                      return (
                        <div key={key} className="px-6 py-4 flex items-center gap-4">
                          {r.ok ? (
                            <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" /></svg>
                          ) : (
                            <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900">{EXPORT_MODULES[key]?.label}</p>
                            {r.ok ? (
                              <p className="text-xs text-gray-500">{r.count} records &middot; {r.filename}</p>
                            ) : (
                              <p className="text-xs text-red-600">{r.error}</p>
                            )}
                          </div>
                          {r.ok && (
                            <button onClick={() => redownload(key)} className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors" style={{ color: S }}>
                              Download Again
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3">
                  <button onClick={backToHub} style={{ background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }} className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all">
                    New Export
                  </button>
                  <Link to="/app" className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Back to Dashboard</Link>
                </div>
              </div>
            )}
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
      heading="Export"
      title="We couldn't load Export"
      message="Please try again. Your store data is untouched — this is just a display issue."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
