import { useRouteError, Link } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { LeafIcon } from "../components/decor";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";

export default function ImportHub() {
  return (
    <s-page heading="Import" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }} className="flex items-center gap-1.5">
            Import <LeafIcon size={14} />
          </span>
        </div>

        {/* ── Hero: Full Store Import ── */}
        <Link
          to="/app/full-import"
          className="group block bg-white rounded-xl border-2 border-green-800/20 p-6 shadow-sm hover:shadow-lg hover:border-green-800/40 transition-all duration-200 hover:-translate-y-0.5"
          style={{ background: "linear-gradient(135deg, rgba(23,50,10,0.03) 0%, rgba(46,99,22,0.06) 100%)" }}
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: P, color: "#fff" }}>
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-gray-900" style={{ fontFamily: F }}>Full Store Import</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider" style={{ background: "rgba(23,50,10,0.1)", color: S }}>Recommended</span>
              </div>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                Import your entire store in one guided flow. Products, collections, inventory, and more &mdash; all at once with smart field mapping.
              </p>
              <div className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold group-hover:gap-2.5 transition-all" style={{ color: S }}>
                Start Full Import
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </div>
            </div>
          </div>
        </Link>

        {/* ── Divider ── */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Or import selectively</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        {/* ── Selective Import Cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { href: "/app/product-importer", label: "Import Products", desc: "Upload products with variants, images, pricing, and SKU", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
            { href: "/app/collections", label: "Import Collections", desc: "Create custom and smart collections from CSV", icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" },
            { href: "/app/inventory", label: "Update Inventory", desc: "Update stock quantities by SKU and location", icon: "M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" },
            { href: "/app/woocommerce-importer", label: "Import from WooCommerce", desc: "Migrate products from a WooCommerce CSV export, variations and all", icon: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5" },
          ].map((item) => (
            <Link key={item.label} to={item.href} className="group bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-3" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
                <svg className="w-4.5 h-4.5" style={{ width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                </svg>
              </div>
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>{item.label}</p>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">{item.desc}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold group-hover:gap-1.5 transition-all" style={{ color: S }}>
                Start <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
              </span>
            </Link>
          ))}
        </div>

        {/* ── Not yet supported — explained, not vague ── */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-700">Pages, Blog Posts, Files and Metafields</p>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                These content types aren&apos;t available via CSV import yet. If you need to move them between stores
                today, use <Link to="/app/transfer" className="font-semibold hover:underline" style={{ color: S }}>Transfer Store</Link> with a direct
                store-to-store connection, or manage them in the Shopify admin. We&apos;ll enable CSV import for these
                once a stable field mapping is finalized.
              </p>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Import"
      title="We couldn't load the Import hub"
      message="Please try again. If the problem continues, contact support and we'll help."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
