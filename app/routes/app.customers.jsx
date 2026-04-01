import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function CustomersPage() {
  const primary = "#17320A";

  return (
    <s-page heading="Customers" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: "#17320A", fontFamily: "'ImportzoFont', sans-serif" }}>Customers</span>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
          <div className="flex flex-col items-center text-center gap-5 max-w-md mx-auto">
            <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)" }}>
              <svg className="w-8 h-8" style={{ color: primary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>

            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Customer Data is Protected</h2>
              <p className="text-sm text-gray-500 leading-relaxed">
                Customer data contains personally identifiable information (PII) such as names, emails, addresses, and phone numbers.
                To protect your customers' privacy and comply with data protection regulations, importing customer data via CSV is not available.
              </p>
            </div>

            <div className="w-full rounded-lg px-4 py-3 flex items-start gap-3" style={{ background: "rgba(23,50,10,0.06)", border: "1px solid rgba(23,50,10,0.15)" }}>
              <svg className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: primary }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-left">
                <p className="text-sm font-medium" style={{ color: primary }}>What you can do instead</p>
                <ul className="text-sm text-gray-600 mt-1 space-y-1">
                  <li>Use <strong>Export Data</strong> to download existing customer records as CSV</li>
                  <li>Add customers individually through your Shopify admin</li>
                  <li>Use Shopify's built-in customer import for bulk operations</li>
                </ul>
              </div>
            </div>

            <div className="flex gap-3 mt-2">
              <a
                href="/app/export"
                className="inline-flex items-center gap-2 px-5 py-2.5 text-white text-sm rounded-lg shadow-sm hover:brightness-110 transition-all"
                style={{ background: primary, fontWeight: 600 }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Export Customers
              </a>
              <a
                href="/app"
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-all"
                style={{ fontWeight: 600 }}
              >
                Back to Dashboard
              </a>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
