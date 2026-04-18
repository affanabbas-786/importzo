// Public route — no Shopify authentication required.
// @shopify/polaris is not a direct dependency in this project; this page
// uses Tailwind classes that match Polaris visual conventions (white card,
// Inter font, 8px grid, Polaris subdued-text colours).

export function meta() {
  return [
    { title: "Privacy Policy — Importzo" },
    { name: "robots", content: "index, follow" },
  ];
}

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-[#f6f6f7] py-10 px-4">
      {/* ── Page header (mirrors Polaris <Page> title bar) ── */}
      <div className="max-w-3xl mx-auto mb-6">
        <h1 className="text-2xl font-semibold text-[#202223]">Privacy Policy</h1>
        <p className="text-sm text-[#6d7175] mt-1">Importzo · Dazzle Tech LLC</p>
      </div>

      {/* ── Card ── */}
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-[#e1e3e5] divide-y divide-[#e1e3e5]">

        {/* Effective date */}
        <div className="px-6 py-4">
          <p className="text-sm text-[#6d7175]">Effective date: April 15, 2026</p>
        </div>

        {/* Intro */}
        <section className="px-6 py-5">
          <p className="text-sm text-[#202223] leading-relaxed">
            Dazzle Tech LLC ("<strong>we</strong>", "<strong>us</strong>", "<strong>our</strong>") operates
            the Importzo Shopify application ("<strong>the App</strong>"). This Privacy Policy explains
            what information we collect when you install and use the App, how we use it, and your rights
            regarding that information.
          </p>
        </section>

        {/* 1 — Data collected */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">1. Data We Collect</h2>
          <ul className="space-y-2 text-sm text-[#202223] leading-relaxed list-none">
            <li className="flex gap-2">
              <span className="text-[#6d7175] select-none">·</span>
              <span><strong>Shop domain</strong> — the <code className="bg-[#f6f6f7] px-1 rounded text-xs">.myshopify.com</code> domain of your store, used to identify your installation.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-[#6d7175] select-none">·</span>
              <span><strong>Access token</strong> — the OAuth access token Shopify issues when you install the App, used solely to make API calls on your behalf.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-[#6d7175] select-none">·</span>
              <span><strong>Source store credentials</strong> — if you use the Store Transfer feature, you voluntarily provide the URL and API token for a source store. These credentials are used only during the active transfer session and are not stored beyond that session.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-[#6d7175] select-none">·</span>
              <span><strong>Import / export / transfer history</strong> — a log of operations (timestamps, record counts, status) so you can review past activity inside the App.</span>
            </li>
          </ul>
          <p className="mt-3 text-sm text-[#6d7175]">
            We do <strong>not</strong> collect personal information about your customers (names, emails, addresses, payment data) unless it is incidentally present in products, collections, or other store data you explicitly choose to transfer.
          </p>
        </section>

        {/* 2 — How it is used */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">2. How We Use Your Data</h2>
          <p className="text-sm text-[#202223] leading-relaxed">
            All collected data is used exclusively to perform the operations you request within the App:
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[#202223] leading-relaxed list-none">
            <li className="flex gap-2"><span className="text-[#6d7175] select-none">·</span><span>Authenticating API calls to your Shopify store</span></li>
            <li className="flex gap-2"><span className="text-[#6d7175] select-none">·</span><span>Importing, exporting, or transferring products, collections, inventory, and themes</span></li>
            <li className="flex gap-2"><span className="text-[#6d7175] select-none">·</span><span>Displaying your activity history within the App dashboard</span></li>
          </ul>
          <p className="mt-3 text-sm text-[#202223] leading-relaxed">
            We do <strong>not</strong> use your data for advertising, profiling, or any purpose unrelated to the App's core functionality.
          </p>
        </section>

        {/* 3 — Data storage */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">3. Data Storage &amp; Security</h2>
          <p className="text-sm text-[#202223] leading-relaxed">
            Data is stored in a SQLite database on a privately managed Virtual Private Server (VPS) located in the United States. The server is operated exclusively by Dazzle Tech LLC. We do <strong>not</strong> share, sell, rent, or otherwise disclose your data to any third parties.
          </p>
          <p className="mt-2 text-sm text-[#202223] leading-relaxed">
            Reasonable technical safeguards are in place, including encrypted connections (TLS) for all API communication and restricted server access.
          </p>
        </section>

        {/* 4 — Retention & deletion */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">4. Data Retention &amp; Deletion</h2>
          <p className="text-sm text-[#202223] leading-relaxed">
            Your shop data (domain, access token, activity history) is retained for as long as the App is installed. When you uninstall the App, Shopify sends us a mandatory <code className="bg-[#f6f6f7] px-1 rounded text-xs">app/uninstalled</code> webhook. Upon receiving this webhook, all data associated with your shop is permanently deleted from our database within 48 hours.
          </p>
          <p className="mt-2 text-sm text-[#202223] leading-relaxed">
            We also process Shopify's GDPR mandatory webhooks:
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[#202223] leading-relaxed list-none">
            <li className="flex gap-2"><span className="text-[#6d7175] select-none">·</span><span><code className="bg-[#f6f6f7] px-1 rounded text-xs">customers/data_request</code> — we confirm we hold no personal customer data.</span></li>
            <li className="flex gap-2"><span className="text-[#6d7175] select-none">·</span><span><code className="bg-[#f6f6f7] px-1 rounded text-xs">customers/redact</code> — we confirm there is no customer PII to redact.</span></li>
            <li className="flex gap-2"><span className="text-[#6d7175] select-none">·</span><span><code className="bg-[#f6f6f7] px-1 rounded text-xs">shop/redact</code> — shop data is permanently deleted within 48 hours of receipt.</span></li>
          </ul>
        </section>

        {/* 5 — Third-party services */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">5. Third-Party Services</h2>
          <p className="text-sm text-[#202223] leading-relaxed">
            The App communicates with the Shopify Admin API on your behalf. No other third-party services, analytics providers, or tracking scripts are used.
          </p>
        </section>

        {/* 6 — Changes */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">6. Changes to This Policy</h2>
          <p className="text-sm text-[#202223] leading-relaxed">
            We may update this Privacy Policy from time to time. Material changes will be reflected with an updated effective date at the top of this page. Continued use of the App after any changes constitutes acceptance of the revised policy.
          </p>
        </section>

        {/* 7 — Contact */}
        <section className="px-6 py-5">
          <h2 className="text-base font-semibold text-[#202223] mb-3">7. Contact</h2>
          <p className="text-sm text-[#202223] leading-relaxed">
            If you have any questions about this Privacy Policy or your data, please contact us:
          </p>
          <div className="mt-3 text-sm text-[#202223] space-y-1">
            <p><strong>Dazzle Tech LLC</strong></p>
            <p>Texas, United States</p>
            <p>
              Email:{" "}
              <a href="mailto:support@dazzletech.co" className="text-[#2c6ecb] hover:underline">
                support@dazzletech.co
              </a>
            </p>
          </div>
        </section>

      </div>
    </div>
  );
}
