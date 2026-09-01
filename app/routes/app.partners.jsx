// ═══════════════════════════════════════════════════════════════════
// Phase 12 — Partner/Agency linking: the payer-facing screen.
//
// A paying store (Pro or Agency) funds Pro-equivalent access on other
// stores it manages, through its OWN Shopify subscription — those stores
// never touch Shopify Billing. Mutations go through the sibling
// api.partner-link.jsx route (see app.scheduled-sync.jsx for the same
// page+sibling-API split).
//
// BILLING RECALCULATION
//
// Shopify's Billing API has no mutation to silently change an existing
// recurring subscription's price — any change needs a fresh
// appSubscriptionCreate the merchant approves on Shopify's own screen.
// Linking/unlinking a partner therefore only ever updates this app's own
// state instantly (features, slot counts) — this page separately computes
// what the live Agency price SHOULD be from the live linked-partner count
// and compares it, by subscription name, against what billing.check()
// reports is actually active (same name-matching approach
// tierFromSubscriptionName already uses elsewhere). A mismatch surfaces a
// banner with an explicit "Update subscription" action — never an
// automatic charge. See partner-linking.server.js and app.billing.jsx's
// select-plan action (extended to accept a partnerCount override).
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsageStatus } from "../lib/usage.server";
import { listLinkedPartners, partnerCount } from "../lib/partner-linking.server";
import {
  PLAN_IDS, PLANS, BILLING_INTERVAL, maxPartnersFor,
  tierFromSubscriptionName, intervalFromShopifyInterval,
  agencyPartnerBillingPlanKey, agencyPartnerPrice,
} from "../lib/plans.js";
import { BRAND } from "../lib/constants";

const P = BRAND.primary, S = BRAND.secondary, F = BRAND.font;

// Same shape app.billing.jsx's intervalOf uses — kept local rather than
// imported cross-route (route modules aren't meant to be shared imports).
function intervalOf(subscription) {
  for (const item of subscription?.lineItems || []) {
    const interval = intervalFromShopifyInterval(item?.plan?.pricingDetails?.interval);
    if (interval) return interval;
  }
  return null;
}

export const loader = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  const [usage, partners, count] = await Promise.all([
    getUsageStatus({ prisma, shop }),
    listLinkedPartners({ prisma, payerShop: shop }),
    partnerCount({ prisma, payerShop: shop }),
  ]);

  const max = maxPartnersFor(usage.tier);

  // Only Agency's price varies with partner count — Pro is flat.
  let divergence = null;
  if (usage.tier === PLAN_IDS.AGENCY) {
    try {
      const { appSubscriptions } = await billing.check();
      const active = (appSubscriptions || []).find((s) => tierFromSubscriptionName(s.name) === PLAN_IDS.AGENCY);
      if (active) {
        const interval = intervalOf(active) || BILLING_INTERVAL.MONTHLY;
        const expectedKey = agencyPartnerBillingPlanKey(count, interval);
        if (active.name !== expectedKey) {
          divergence = { interval, expectedPrice: agencyPartnerPrice(count, interval) };
        }
      }
    } catch (err) {
      // A Shopify hiccup here must not break the page — the banner just
      // doesn't show this load; nothing was silently charged either way.
      console.warn(`[app.partners] billing.check failed for ${shop}:`, err?.message);
    }
  }

  // Flag, don't auto-revoke: a downgrade below the new tier's cap (e.g.
  // Agency -> Pro while still funding 3 partners) is surfaced here, never
  // silently unlinked — see partner-linking.server.js.
  const overCap = count > max;

  return {
    tier: usage.tier,
    tierLabel: usage.label,
    maxPartners: max,
    partners,
    count,
    overCap,
    divergence,
  };
};

export default function PartnersPage() {
  const { tier, tierLabel, maxPartners, partners, count, overCap, divergence } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const [domain, setDomain] = useState("");
  const [code, setCode] = useState("");

  const isWarning = fetcher.data?.warning === true;
  const lastError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  // The API is a sibling route, so a successful write needs the loader
  // re-run to show the new list/counts.
  const revalidate = fetcher.data?.ok;
  useEffect(() => {
    if (revalidate) {
      fetcher.load("/app/partners");
      setDomain("");
      setCode("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revalidate]);

  const post = (fields) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
    fetcher.submit(fd, { method: "post", action: "/api/partner-link" });
  };

  function submitLink(confirmOverwrite) {
    post({ intent: "link-partner", partnerDomain: domain, pairingCode: code, confirmOverwrite: String(confirmOverwrite) });
  }

  function updateSubscription() {
    const fd = new FormData();
    fd.append("intent", "select-plan");
    fd.append("plan", PLAN_IDS.AGENCY);
    fd.append("interval", divergence.interval);
    fd.append("partnerCount", String(count));
    fetcher.submit(fd, { method: "post", action: "/app/billing" });
  }

  const canAddPartner = tier !== PLAN_IDS.FREE && count < maxPartners;

  return (
    <s-page heading="Partner Stores" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <p className="text-sm text-gray-600 max-w-2xl">
          Fund Pro-equivalent access on other stores you manage through your own {tierLabel} subscription
          — they never touch Shopify Billing, and can unlink themselves at any time.
        </p>

        {tier === PLAN_IDS.FREE && (
          <div className="rounded-xl border p-4 flex items-start gap-3"
            style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }}>
            <span className="text-xs font-semibold px-2 py-1 rounded-full flex-shrink-0"
              style={{ background: S, color: "#fff" }}>Pro feature</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
                Partner stores aren&apos;t included on Free
              </p>
              <p className="text-xs text-gray-600 mt-0.5">
                Available on Pro (1 partner) and Agency (up to 5) — from ${PLANS[PLAN_IDS.PRO].price}/month.{" "}
                <Link to="/app/billing" className="font-semibold hover:underline" style={{ color: S }}>
                  View plans
                </Link>
              </p>
            </div>
          </div>
        )}

        {divergence && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Your Agency subscription is out of date</p>
            <p className="text-xs text-amber-800 mt-1 leading-relaxed">
              Based on {count} linked partner{count === 1 ? "" : "s"}, your Agency price should be{" "}
              ${divergence.expectedPrice}/{divergence.interval === BILLING_INTERVAL.YEARLY ? "year" : "month"}.
              Nothing has been charged automatically — updating shows you one Shopify approval screen for the new price.
            </p>
            <button
              type="button" onClick={updateSubscription} disabled={busy}
              className="mt-2 px-3 py-1.5 text-xs font-semibold rounded-lg text-white hover:brightness-110 disabled:opacity-50"
              style={{ background: P, fontFamily: F }}
            >
              Update subscription
            </button>
          </div>
        )}

        {overCap && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              More partner stores are linked than {tierLabel} includes
            </p>
            <p className="text-xs text-amber-800 mt-1 leading-relaxed">
              {tierLabel} includes {maxPartners} partner slot{maxPartners === 1 ? "" : "s"}, but {count} {count === 1 ? "is" : "are"} currently
              linked. Nothing has been switched off — upgrade your plan or remove a partner store below to resolve it.
            </p>
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-1">
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>Linked partner stores</p>
            <span className="text-xs text-gray-500">{count}/{maxPartners} partner slot{maxPartners === 1 ? "" : "s"} used</span>
          </div>

          {partners.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-gray-700">No partner stores linked yet</p>
              <p className="text-xs text-gray-400 mt-1">
                Add one below using its myshopify domain and the pairing code it generates.
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
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>Add partner store</p>
          </div>

          <fieldset disabled={!canAddPartner} className="px-5 py-4 border-0 m-0">
            {!canAddPartner && tier !== PLAN_IDS.FREE && (
              <p className="text-xs text-amber-800 mb-3">You&apos;re at your plan&apos;s partner limit ({maxPartners}).</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Partner&apos;s myshopify domain</span>
                <input
                  type="text" value={domain} onChange={(e) => setDomain(e.target.value)}
                  placeholder="store-name.myshopify.com"
                  className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Pairing code</span>
                <input
                  type="text" value={code} onChange={(e) => setCode(e.target.value)}
                  placeholder="123456" maxLength={6}
                  className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50"
                />
              </label>
            </div>

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
              type="button" disabled={!canAddPartner || busy || !domain || !code}
              onClick={() => submitLink(false)}
              className="mt-4 px-5 py-2.5 text-sm rounded-lg text-white font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: P, fontFamily: F }}
            >
              {busy ? "Linking…" : "Link partner store"}
            </button>
          </fieldset>
        </div>
      </div>
    </s-page>
  );
}
