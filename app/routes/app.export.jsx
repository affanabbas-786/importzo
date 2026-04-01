import { useState, useCallback, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, apiVersion } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const exportType = formData.get("exportType");
  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";

  async function fetchAll(resource, fields) {
    const items = [];
    let url = `https://${shopDomain}/admin/api/${version}/${resource}.json?limit=250${fields ? `&fields=${fields}` : ""}`;
    while (url) {
      const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
      if (!res.ok) throw new Error(`Failed to fetch ${resource}: HTTP ${res.status}`);
      const data = await res.json();
      const key = Object.keys(data).find((k) => Array.isArray(data[k]));
      if (key) items.push(...data[key]);
      const link = res.headers.get("Link");
      url = null;
      if (link) {
        const match = link.match(/<([^>]+)>;\s*rel="next"/);
        if (match) url = match[1];
      }
    }
    return items;
  }

  function escapeCsv(val) {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function toCsv(headers, rows) {
    const lines = [headers.map(escapeCsv).join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => escapeCsv(row[h] ?? "")).join(","));
    }
    return lines.join("\n");
  }

  try {
    if (exportType === "products") {
      const products = await fetchAll("products", "id,title,handle,body_html,vendor,product_type,tags,published_at,variants,images");
      const rows = [];
      for (const p of products) {
        const variants = p.variants || [{}];
        const images = (p.images || []).map((img) => img.src);
        for (let vi = 0; vi < variants.length; vi++) {
          const v = variants[vi];
          rows.push({
            Handle: p.handle || "",
            Title: vi === 0 ? (p.title || "") : "",
            "Body (HTML)": vi === 0 ? (p.body_html || "") : "",
            Vendor: vi === 0 ? (p.vendor || "") : "",
            "Product Type": vi === 0 ? (p.product_type || "") : "",
            Tags: vi === 0 ? (p.tags || "") : "",
            Published: p.published_at ? "TRUE" : "FALSE",
            "Option1 Name": v.option1 ? (p.options?.[0]?.name || "Title") : "",
            "Option1 Value": v.option1 || "",
            "Option2 Name": v.option2 ? (p.options?.[1]?.name || "") : "",
            "Option2 Value": v.option2 || "",
            "Option3 Name": v.option3 ? (p.options?.[2]?.name || "") : "",
            "Option3 Value": v.option3 || "",
            "Variant SKU": v.sku || "",
            "Variant Price": v.price || "",
            "Variant Barcode": v.barcode || "",
            "Variant Inventory Qty": v.inventory_quantity ?? "",
            "Variant Weight": v.weight || "",
            "Variant Weight Unit": v.weight_unit || "",
            "Image Src": vi === 0 && images[0] ? images[0] : (images[vi] || ""),
          });
        }
      }
      const csvHeaders = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Type", "Tags", "Published", "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value", "Variant SKU", "Variant Price", "Variant Barcode", "Variant Inventory Qty", "Variant Weight", "Variant Weight Unit", "Image Src"];
      const csv = toCsv(csvHeaders, rows);
      return new Response(JSON.stringify({ csv, filename: `products_export_${new Date().toISOString().slice(0, 10)}.csv`, count: products.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (exportType === "customers") {
      const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken };
      const allCustomers = [];
      let hasNextPage = true;
      let cursor = null;

      while (hasNextPage) {
        const query = `{
          customers(first: 250${cursor ? `, after: "${cursor}"` : ""}) {
            edges {
              cursor
              node {
                id
                firstName
                lastName
                email
                phone
                createdAt
                tags
                note
                taxExempt
                addresses {
                  address1
                  city
                  province
                  zip
                  country
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }`;

        const gqlRes = await fetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query }),
        });
        if (!gqlRes.ok) throw new Error(`Failed to fetch customers: HTTP ${gqlRes.status}`);
        const gqlData = await gqlRes.json();

        if (gqlData.errors) {
          throw new Error(gqlData.errors.map(e => e.message).join(", "));
        }

        const edges = gqlData.data?.customers?.edges || [];
        for (const edge of edges) {
          allCustomers.push(edge.node);
          cursor = edge.cursor;
        }
        hasNextPage = gqlData.data?.customers?.pageInfo?.hasNextPage || false;
      }

      const rows = allCustomers.map((c) => {
        const addr = (c.addresses || [])[0] || {};
        return {
          "First Name": c.firstName || "",
          "Last Name": c.lastName || "",
          Email: c.email || "",
          Phone: c.phone || "",
          Address: addr.address1 || "",
          City: addr.city || "",
          Province: addr.province || "",
          Zip: addr.zip || "",
          Country: addr.country || "",
          Tags: Array.isArray(c.tags) ? c.tags.join(", ") : (c.tags || ""),
          Note: c.note || "",
          "Tax Exempt": c.taxExempt ? "TRUE" : "FALSE",
        };
      });
      const csvHeaders = ["First Name", "Last Name", "Email", "Phone", "Address", "City", "Province", "Zip", "Country", "Tags", "Note", "Tax Exempt"];
      const csv = toCsv(csvHeaders, rows);
      return new Response(JSON.stringify({ csv, filename: `customers_export_${new Date().toISOString().slice(0, 10)}.csv`, count: allCustomers.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (exportType === "collections") {
      const custom = await fetchAll("custom_collections", "id,title,handle,body_html,published_at,sort_order,image");
      const smart = await fetchAll("smart_collections", "id,title,handle,body_html,published_at,sort_order,image");
      const all = [
        ...custom.map((c) => ({ ...c, _type: "Custom" })),
        ...smart.map((c) => ({ ...c, _type: "Smart" })),
      ];
      const rows = all.map((c) => ({
        Title: c.title || "",
        Handle: c.handle || "",
        "Body HTML": c.body_html || "",
        Type: c._type,
        Published: c.published_at ? "TRUE" : "FALSE",
        "Sort Order": c.sort_order || "",
        "Image Src": c.image?.src || "",
      }));
      const csvHeaders = ["Title", "Handle", "Body HTML", "Type", "Published", "Sort Order", "Image Src"];
      const csv = toCsv(csvHeaders, rows);
      return new Response(JSON.stringify({ csv, filename: `collections_export_${new Date().toISOString().slice(0, 10)}.csv`, count: all.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown export type" }), { status: 400, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

export default function ExportPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const [exporting, setExporting] = useState(null);
  const [error, setError] = useState("");

  const downloadedRef = useRef(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !downloadedRef.current) {
      downloadedRef.current = true;
      const data = fetcher.data;
      if (data.error) {
        setError(data.error);
        shopify.toast.show(`Export failed: ${data.error}`, { isError: true });
      } else if (data.csv) {
        const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        shopify.toast.show(`Exported ${data.count} ${exporting || "items"} to CSV`);
      }
      setExporting(null);
    }
  }, [fetcher.state, fetcher.data, shopify, exporting]);

  const handleExport = useCallback((type) => {
    setExporting(type);
    setError("");
    downloadedRef.current = false;
    fetcher.submit({ exportType: type }, { method: "POST" });
  }, [fetcher]);

  const primary = "#17320A";
  const secondary = "#2E6316";

  const exportOptions = [
    {
      type: "products",
      title: "Products",
      desc: "Export all products with variants, prices, images, and inventory",
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      ),
    },
    {
      type: "customers",
      title: "Customers",
      desc: "Export all customers with addresses, tags, and contact info",
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
        </svg>
      ),
    },
    {
      type: "collections",
      title: "Collections",
      desc: "Export all custom and smart collections",
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
      ),
    },
  ];

  return (
    <s-page heading="Export Data" subtitle="Download your Shopify data as CSV" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: "#17320A", fontFamily: "'ImportzoFont', sans-serif" }}>Export Data</span>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center gap-3">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm font-medium text-red-800">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {exportOptions.map((opt) => (
            <div key={opt.type} className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: "rgba(23,50,10,0.1)", color: secondary }}>
                  {opt.icon}
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{opt.title}</h3>
                  <p className="text-sm text-gray-500 mt-1">{opt.desc}</p>
                </div>
                <button
                  onClick={() => handleExport(opt.type)}
                  disabled={exporting !== null}
                  style={exporting === null ? { background: primary, color: "#fff", borderRadius: 8, fontWeight: 600 } : { borderRadius: 8 }}
                  className={`w-full px-5 py-2.5 text-sm rounded-lg transition-all ${
                    exporting === null
                      ? "shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(23,50,10,0.3)] active:scale-[0.98]"
                      : "bg-gray-200 text-gray-400 cursor-not-allowed"
                  }`}
                >
                  {exporting === opt.type ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Exporting...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      Export CSV
                    </span>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-gray-700">About exports</p>
              <p className="text-sm text-gray-500 mt-1">
                Exports include all data from your Shopify store in standard CSV format.
                Products include all variants. Customers include primary address.
                Collections include both custom and smart types.
              </p>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
