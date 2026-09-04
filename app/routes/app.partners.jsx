// ═══════════════════════════════════════════════════════════════════
// Phase 12 — Partner/Agency linking: the payer-facing screen.
//
// A paying store (Pro or Agency) funds Pro-equivalent access on companion
// stores it manages, through its OWN Shopify subscription — those stores
// never touch Shopify Billing. Mutations go through the sibling
// api.partner-link.jsx route (see app.scheduled-sync.jsx for the same
// page+sibling-API split).
//
// Pricing is flat per tier (Pro: payer + 1 companion; Agency: payer + 5),
// so linking or unlinking a companion never changes what this store is
// billed — there is nothing to reconcile and no "update subscription"
// step. Linking is direct: enter the companion's myshopify.com domain, no
// pairing code. The companion is notified after the fact by a persistent
// banner on its own dashboard and can self-unlink at any time.
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsageStatus } from "../lib/usage.server";
import { listLinkedPartners, partnerCount } from "../lib/partner-linking.server";
import { PLAN_IDS, PLANS, maxPartnersFor } from "../lib/plans.js";
import { BRAND } from "../lib/constants";

const P = BRAND.primary, S = BRAND.secondary, F = BRAND.font;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [usage, partners, count] = await Promise.all([
    getUsageStatus({ prisma, shop }),
    listLinkedPartners({ prisma, payerShop: shop }),
    partnerCount({ prisma, payerShop: shop }),
  ]);

  const max = maxPartnersFor(usage.tier);

  // Flag, don't auto-revoke: a downgrade below the new tier's cap (e.g.
  // Agency -> Pro while still funding 3 companions) is surfaced here, never
  // silently unlinked — see partner-linking.server.js.
  const overCap = count > max;

  return {
    tier: usage.tier,
    tierLabel: usage.label,
    maxPartners: max,
    partners,
    count,
    overCap,
  };
};

export default function PartnersPage() {
  const { tier, tierLabel, maxPartners, partners, count, overCap } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const [domain, setDomain] = useState("");

  const isWarning = fetcher.data?.warning === true;
  const lastError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  // The API is a sibling route, so a successful write needs the loader
  // re-run to show the new list/counts.
  const revalidate = fetcher.data?.ok;
  useEffect(() => {
    if (revalidate) {
      fetcher.load("/app/partners");
      setDomain("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revalidate]);

  const post = (fields) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
    fetcher.submit(fd, { method: "post", action: "/api/partner-link" });
  };

  function submitLink(confirmOverwrite) {
    post({ intent: "link-partner", partnerDomain: domain, confirmOverwrite: String(confirmOverwrite) });
  }

  const canAddPartner = tier !== PLAN_IDS.FREE && count < maxPartners;

  return (
    <s-page heading="Companion Stores" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <p className="text-sm text-gray-600 max-w-2xl">
          Fund Pro-equivalent access on other stores you manage through your own {tierLabel} subscription
          — they never touch Shopify Billing, your price doesn&apos;t change, and they can unlink themselves
          at any time.
        </p>

        {tier === PLAN_IDS.FREE && (
          <div className="rounded-xl border p-4 flex items-start gap-3"
            style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }}>
            <span className="text-xs font-semibold px-2 py-1 rounded-full flex-shrink-0"
              style={{ background: S, color: "#fff" }}>Pro feature</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
                Companion stores aren&apos;t included on Free
              </p>
              <p className="text-xs text-gray-600 mt-0.5">
                Pro (${PLANS[PLAN_IDS.PRO].price}/mo) covers you plus 1 companion; Agency (${PLANS[PLAN_IDS.AGENCY].price}/mo) covers you plus 5.{" "}
                <Link to="/app/billing" className="font-semibold hover:underline" style={{ color: S }}>
                  View plans
                </Link>
              </p>
            </div>
          </div>
        )}

        {overCap && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              More companion stores are linked than {tierLabel} includes
            </p>
            <p className="text-xs text-amber-800 mt-1 leading-relaxed">
              {tierLabel} includes {maxPartners} companion slot{maxPartners === 1 ? "" : "s"}, but {count} {count === 1 ? "is" : "are"} currently
              linked. Nothing has been switched off — upgrade your plan or remove a companion store below to resolve it.
            </p>
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-1">
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>Linked companion stores</p>
            <span className="text-xs text-gray-500">{count}/{maxPartners} companion slot{maxPartners === 1 ? "" : "s"} used</span>
          </div>

          {partners.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-gray-700">No companion stores linked yet</p>
              <p className="text-xs text-gray-400 mt-1">
                Add one below using its myshopify.com domain — it needs Importzo installed first.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {partners.map((partner) => (
                <li key={partner.shop} className="px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{partner.shop}</p>
                    {partner.hasIndependentSubscription && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Has its own paid subscription — billing unaffected by this link
                      </p>
                    )}
                  </div>
                  <button
                    type="button" disabled={busy}
                    onClick={() => post({ intent: "remove-partner", partnerShop: partner.shop })}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
          style={{ opacity: canAddPartner ? 1 : 0.55 }}>
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>Add companion store</p>
          </div>

          <fieldset disabled={!canAddPartner} className="px-5 py-4 border-0 m-0">
            {!canAddPartner && tier !== PLAN_IDS.FREE && (
              <p className="text-xs text-amber-800 mb-3">You&apos;re at your plan&apos;s companion limit ({maxPartners}).</p>
            )}
            <label className="block max-w-md">
              <span className="text-xs font-medium text-gray-700">Companion&apos;s myshopify.com domain</span>
              <input
                type="text" value={domain} onChange={(e) => setDomain(e.target.value)}
                placeholder="store-name.myshopify.com"
                className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50"
              />
            </label>
            <p className="text-xs text-gray-500 mt-2 leading-relaxed">
              The store is linked immediately and gets Pro features. It&apos;s notified on its own dashboard
              and can unlink itself at any time.
            </p>

            {isWarning && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs text-amber-800">{lastError}</p>
                <button
                  type="button" disabled={busy} onClick={() => submitLink(true)}
                  className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg border border-amber-300 text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  Link anyway
                </button>
              </div>
            )}

            {!isWarning && lastError && (
              <p className="mt-3 text-xs text-red-700">{lastError}</p>
            )}

            <button
              type="button" disabled={!canAddPartner || busy || !domain}
              onClick={() => submitLink(false)}
              className="mt-4 px-5 py-2.5 text-sm rounded-lg text-white font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: P, fontFamily: F }}
            >
              {busy ? "Linking…" : "Link companion store"}
            </button>
          </fieldset>
        </div>
      </div>
    </s-page>
  );
}
