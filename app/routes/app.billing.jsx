import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { getUsageStatus, setShopTier } from "../lib/usage.server";
import { checkAgencyEligibility, syncAgencyIneligibilityFlag } from "../lib/agency-eligibility.server";
import { planSelectionUrl, resolveAppHandle } from "../lib/app-pricing.server";
import {
  PLAN_IDS, PLANS, PLAN_ORDER, AGENCY_MIN_STORES, BILLING_INTERVAL,
  tierFromSubscriptionName, intervalFromShopifyInterval, yearlySavingsPercent,
} from "../lib/plans.js";
import { REDIRECT_OVERLAY_COPY, beginPlanSelection, shouldDismissOverlay } from "../lib/billing-ui.js";
import { BRAND } from "../lib/constants";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { PlanCard } from "../components/PlanCard";
import { RedirectingOverlay } from "../components/RedirectingOverlay";

// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Billing: plan UI.
// Phase 8 — rewired for Shopify App Pricing (formerly Managed Pricing).
//
// This app is registered for Shopify App Pricing in the Partner Dashboard,
// which makes Shopify the owner of both the plan-selection page and the
// charge. appSubscriptionCreate is rejected for such apps outright
// ("Managed Pricing Apps cannot use the Billing API (to create charges)"),
// so the Subscribe buttons no longer call billing.request — they redirect
// to Shopify's hosted plan-selection page (see app-pricing.server.js).
//
// READING plan state is unchanged. billing.check() is a query against
// currentAppInstallation.activeSubscriptions and returns App Pricing
// subscriptions exactly as it did Billing API ones, so reconcile() below is
// still the single place Shopify's billing state becomes a local tier —
// ShopPlan.tier, the value every write path actually enforces against.
// ═══════════════════════════════════════════════════════════════════

/**
 * Reconciles ShopPlan.tier against Shopify's actual AppSubscription state.
 * The merchant can approve or cancel a plan from places this app never sees
 * a request for — and under App Pricing that is now the NORMAL path, not the
 * exception: every subscribe happens on Shopify's page, off-site. This is
 * where it gets pulled back in sync, on every Billing page load.
 */
async function reconcile({ billing, shop }) {
  const { appSubscriptions } = await billing.check();

  // Match on the tier keyword rather than an exact plan name: under App
  // Pricing the name is whatever the Partner Dashboard calls it, in the
  // merchant's language, and monthly/yearly may be named separately. See
  // tierFromSubscriptionName — failing to recognise a real paid subscription
  // here would silently downgrade a paying merchant to Free.
  const active = appSubscriptions.find((s) => tierFromSubscriptionName(s.name));

  if (active) {
    const status = await setShopTier({
      prisma, shop, tier: tierFromSubscriptionName(active.name),
      subscriptionId: active.id, subscriptionStatus: active.status,
    });
    return { ...status, interval: intervalOf(active), subscriptionName: active.name };
  }

  // No active Shopify subscription. If this shop is still marked paid
  // locally, the charge lapsed or was cancelled outside this app — drop
  // back to Free rather than keep enforcing a paid shop's limits/features
  // for a subscription that no longer exists.
  const current = await getUsageStatus({ prisma, shop });
  if (current.tier === PLAN_IDS.FREE) return { ...current, interval: null, subscriptionName: null };

  const downgraded = await setShopTier({ prisma, shop, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: null });
  return { ...downgraded, interval: null, subscriptionName: null };
}

// Monthly vs yearly, read off the subscription's recurring line item.
// Informational only — nothing is gated on it; it's so the page can say
// "billed yearly" instead of implying everyone pays monthly.
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
  const version = apiVersion || "2025-10";

  let usage;
  try {
    usage = await reconcile({ billing, shop });
  } catch (err) {
    // Reconciliation failing (Shopify API hiccup) must not break the page —
    // it just falls back to whatever ShopPlan already has on file.
    console.warn(`[app.billing] reconciliation failed for ${shop}:`, err?.message);
    usage = { ...(await getUsageStatus({ prisma, shop })), interval: null, subscriptionName: null };
  }

  const eligibility = await checkAgencyEligibility({
    prisma, shopifyGraphql, shop, token: session.accessToken, version,
  });

  // Phase 8 — Shopify's hosted plan page can't enforce the 3-store Agency
  // rule, so a shop can end up on Agency without qualifying. Record it (the
  // page renders a notice below; the flag also makes it reportable without
  // waiting for the merchant to visit). Never revokes access — see
  // syncAgencyIneligibilityFlag for why that's the deliberate choice.
  const agencyIneligibleSince = await syncAgencyIneligibilityFlag({
    prisma, shop, tier: usage.tier, eligible: eligibility.eligible,
  });

  const appHandle = await resolveAppHandle({
    shopifyGraphql, shop, token: session.accessToken, version,
  });

  // Shopify appends ?plan_handle=... when it sends the merchant back after
  // they pick a plan. Its only use here is to confirm the round trip
  // happened — the tier itself always comes from reconcile() above, never
  // from a URL parameter the merchant could edit.
  const justSelectedPlan = new URL(request.url).searchParams.get("plan_handle");

  return {
    usage: { ...usage, agencyIneligibleSince },
    eligibility,
    planSelectionUrl: planSelectionUrl({ shop, appHandle }),
    justSelectedPlan,
  };
};

/**
 * The only remaining server action: send the merchant to Shopify's hosted
 * plan-selection page.
 *
 * `redirect` from authenticate.admin with target "_top" is the supported way
 * out of the embedded iframe — for a fetcher POST like this one it throws a
 * 401 carrying the reauthorize-URL header, which App Bridge's patched fetch
 * turns into a top-level navigation. (This is the same mechanism the old
 * billing.request call relied on; only the destination changed.)
 *
 * There is no per-plan URL under App Pricing — Shopify hosts ONE page
 * showing every plan — so this takes no plan argument. The Agency
 * eligibility rule is therefore no longer enforceable at this point; it is
 * surfaced before the click (the warning on the Agency card) and recorded
 * after it (syncAgencyIneligibilityFlag in the loader).
 */
export const action = async ({ request }) => {
  const { session, redirect } = await authenticate.admin(request);
  const shop = session.shop;
  const version = apiVersion || "2025-10";
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "select-plan") {
    return Response.json({ ok: false, error: `Unsupported intent "${intent}"` }, { status: 400 });
  }

  const appHandle = await resolveAppHandle({
    shopifyGraphql, shop, token: session.accessToken, version,
  });
  const url = planSelectionUrl({ shop, appHandle });

  console.log(`[app.billing] redirecting ${shop} to Shopify App Pricing plan selection: ${url}`);
  return redirect(url, { target: "_top" });
};

const { primary: P, secondary: S, font: F } = BRAND;

function UsageCard({ usage }) {
  const pct = usage.isUnlimited ? 0 : Math.min(100, Math.round((usage.used / Math.max(usage.limit, 1)) * 100));
  const atLimit = !usage.isUnlimited && usage.remaining === 0;
  const intervalLabel = usage.interval === BILLING_INTERVAL.YEARLY
    ? " · billed yearly"
    : usage.interval === BILLING_INTERVAL.MONTHLY ? " · billed monthly" : "";

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">Current plan: {usage.label}{intervalLabel}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {usage.isUnlimited
              ? "Unlimited records this month"
              : `${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} records used this month`}
          </p>
        </div>
        {atLimit && (
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700">
            Monthly limit reached
          </span>
        )}
      </div>
      {!usage.isUnlimited && (
        <div className="mt-3 h-2 w-full rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: atLimit ? "#dc2626" : S }}
          />
        </div>
      )}
    </div>
  );
}

UsageCard.propTypes = {
  usage: PropTypes.shape({
    label: PropTypes.string,
    used: PropTypes.number,
    limit: PropTypes.number,
    remaining: PropTypes.number,
    isUnlimited: PropTypes.bool,
    interval: PropTypes.string,
  }).isRequired,
};

/**
 * Phase 8 — the notice for a shop holding Agency without meeting the
 * 3-store requirement.
 *
 * Deliberately states all three things a merchant needs to know and none of
 * the ones they don't: nothing has been turned off, this IS being tracked,
 * and here are the two ways out. Silence in either direction — letting it
 * pass unmentioned, or quietly degrading the account — was the thing to
 * avoid.
 */
function AgencyIneligibleNotice({ eligibility, since, planSelectionUrl: url }) {
  const shortfall = Math.max(0, AGENCY_MIN_STORES - eligibility.storeCount);
  const flaggedOn = since ? new Date(since).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-5">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-900" style={{ fontFamily: F }}>
            You&apos;re on Agency pricing, but this account doesn&apos;t qualify yet
          </p>
          <p className="mt-1.5 text-xs text-amber-800 leading-relaxed">
            Agency&apos;s discounted rate is for merchants running Importzo on {AGENCY_MIN_STORES} or more stores.
            We currently count <strong>{eligibility.storeCount}</strong> {eligibility.storeCount === 1 ? "store" : "stores"} under
            your store contact email{shortfall > 0 ? ` — ${shortfall} short` : ""}.
          </p>
          <p className="mt-2 text-xs text-amber-800 leading-relaxed">
            <strong>Nothing has been switched off.</strong> Every Importzo feature stays fully available and
            your imports keep running — Agency and Pro include exactly the same features, so this is a
            pricing question, not an access one.
            {flaggedOn ? ` We've noted this on your account since ${flaggedOn}.` : ""} If the store count
            doesn&apos;t reach {AGENCY_MIN_STORES}, we may ask you to move to Pro pricing; we&apos;ll contact you first and
            never change your plan without telling you.
          </p>
          <p className="mt-2 text-xs text-amber-800 leading-relaxed">
            To resolve it: install Importzo on {shortfall > 0 ? `${shortfall} more ${shortfall === 1 ? "store" : "stores"}` : "your other stores"} using
            the same store contact email, or switch to Pro on your plan page.
          </p>
          <a
            href={url}
            target="_top"
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-amber-900 hover:underline"
          >
            Manage your plan in Shopify
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
          </a>
          <p className="mt-2 text-[11px] text-amber-700">
            Think this is wrong? Stores are matched by their Shopify contact email — if your stores use
            different addresses, email support@dazzletech.co and we&apos;ll link them by hand.
          </p>
        </div>
      </div>
    </div>
  );
}

AgencyIneligibleNotice.propTypes = {
  eligibility: PropTypes.shape({ storeCount: PropTypes.number }).isRequired,
  // Date, not string: React Router's single-fetch (turbo-stream) preserves
  // Date instances across the loader boundary, so this arrives as the Date
  // syncAgencyIneligibilityFlag returned. Accepts both so the prop stays
  // honest either way — new Date() handles each.
  since: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)]),
  planSelectionUrl: PropTypes.string.isRequired,
};

export default function BillingPage() {
  const { usage, eligibility, planSelectionUrl: url, justSelectedPlan } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const showAgencyNotice = usage.tier === PLAN_IDS.AGENCY && !eligibility.eligible;

  // Drives RedirectingOverlay. Set true the instant a plan is selected —
  // BEFORE the fetcher submits — and only ever cleared on a failed action.
  // See shouldDismissOverlay in billing-ui.js for why it must not track
  // fetcher.state directly.
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    if (shouldDismissOverlay({ state: fetcher.state, data: fetcher.data })) {
      setOverlayOpen(false);
    }
    if (fetcher.data?.ok === false && fetcher.state === "idle") {
      shopify.toast.show(fetcher.data.error || "Could not open the plan page", { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  // Shopify sends the merchant back here after they pick a plan. The tier
  // shown has already been reconciled from billing.check() by the loader, so
  // this is only a confirmation that the round trip landed.
  useEffect(() => {
    if (justSelectedPlan) {
      shopify.toast.show(`You're on the ${usage.label} plan`);
    }
  }, [justSelectedPlan, usage.label, shopify]);

  function handleSelectPlan(plan) {
    beginPlanSelection({
      plan,
      currentTier: usage.tier,
      showOverlay: () => setOverlayOpen(true),
      submit: () => fetcher.submit({ intent: "select-plan" }, { method: "POST" }),
    });
  }

  return (
    <s-page heading="Billing" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <RedirectingOverlay
        open={overlayOpen}
        title={REDIRECT_OVERLAY_COPY.title}
        timing={REDIRECT_OVERLAY_COPY.timing}
        reassurance={REDIRECT_OVERLAY_COPY.reassurance}
      />
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }}>Billing</span>
        </div>

        <UsageCard usage={usage} />

        {showAgencyNotice && (
          <AgencyIneligibleNotice
            eligibility={eligibility}
            since={usage.agencyIneligibleSince}
            planSelectionUrl={url}
          />
        )}

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>Plans</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Plans are billed through Shopify. Choosing a plan opens Shopify&apos;s own plan page, where you
              pick monthly or yearly billing and approve the charge — upgrading takes effect as soon as you
              approve it. To cancel or change payment details, use the same page, or Shopify
              admin&apos;s Apps &amp; sales channels &rarr; Manage app &rarr; Billing.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {PLAN_ORDER.map((id) => (
              <PlanCard
                key={id}
                plan={PLANS[id]}
                currentTier={usage.tier}
                eligibility={eligibility}
                onSelect={() => handleSelectPlan(PLANS[id])}
                busy={busy}
                planSelectionUrl={url}
              />
            ))}
          </div>
          <p className="text-xs text-gray-400">
            Yearly billing saves {yearlySavingsPercent(PLAN_IDS.PRO)}% versus paying month to month. Prices in USD.
          </p>
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Billing"
      title="We couldn't load Billing"
      message="Please try again. You can still reach us directly at support@dazzletech.co."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
