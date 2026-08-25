import { useEffect, useRef, useState } from "react";
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
  PLAN_IDS, PLANS, AGENCY_MIN_STORES, BILLING_INTERVAL, billingPlanKey,
  tierFromSubscriptionName, intervalFromShopifyInterval, yearlySavingsPercent,
  isComplimentary,
} from "../lib/plans.js";
import { isTestCharge, isManagedPricingRejection, describeBillingError } from "../lib/billing-mode.server";
import { trialDaysOverrideFor } from "../lib/billing-trial.server";
import {
  REDIRECT_OVERLAY_COPY, CANCEL_CONFIRM_COPY, ALL_PLANS_INCLUDE, PERIOD_TOGGLE_OPTIONS,
  beginPlanSelection, shouldDismissOverlay,
  shouldDismissOverlayOnReshow, planConfirmationToast, planFeatures,
  planDisplayOrder, isFeaturedPlan,
} from "../lib/billing-ui.js";
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

  // A complimentary grant has no Shopify subscription by definition, so the
  // "no active subscription" branch is not evidence of a lapsed charge here —
  // it is the expected steady state. Downgrading would revoke the grant on the
  // merchant's next Billing page load. See COMPLIMENTARY_STATUS in plans.js.
  if (isComplimentary(current.subscriptionStatus)) {
    return { ...current, interval: null, subscriptionName: null };
  }

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

  // Shopify appends ?plan_handle=... when it sends the merchant back after
  // they pick a plan. Its only use here is to confirm the round trip
  // happened — the tier itself always comes from reconcile() above, never
  // from a URL parameter the merchant could edit.
  const justSelectedPlan = new URL(request.url).searchParams.get("plan_handle");

  return {
    usage: { ...usage, agencyIneligibleSince },
    eligibility,
    justSelectedPlan,
  };
};

/**
 * Fallback for the window between deploying this code and switching the
 * Partner Dashboard off Shopify App Pricing.
 *
 * While App Pricing is still on, Shopify refuses appSubscriptionCreate. That
 * is expected, not exceptional — it is the deliberate deploy order — so the
 * merchant gets exactly what they got before: the hosted plan page. The one
 * thing this must never do is surface an error, because nothing is wrong.
 */
async function redirectToHostedPlanPage({ redirect, shop, token, version }) {
  const appHandle = await resolveAppHandle({ shopifyGraphql, shop, token, version });
  const url = planSelectionUrl({ shop, appHandle });
  console.log(`[app.billing] App Pricing still enabled for ${shop} — falling back to hosted plan page: ${url}`);
  return redirect(url, { target: "_top" });
}

/**
 * Phase 10 — the merchant's plan choice is now carried through to the charge.
 *
 * Two intents:
 *
 *   select-plan  tier + interval -> billing.request for exactly that plan.
 *                Shopify shows ONE approval screen for that specific charge
 *                and returns to /app/billing. The hosted plan-selection page
 *                never appears.
 *
 *   cancel-plan  Free has no charge to create, so there is nothing to
 *                approve and nowhere to send the merchant: cancel the live
 *                subscription(s) and flip the local tier, entirely inside the
 *                app.
 *
 * The tier and interval are resolved into a billing key HERE via
 * billingPlanKey rather than the client naming the charge, so the price the
 * merchant was shown is the one Shopify actually bills. A client that posts
 * `plan=agency&interval=yearly` gets the Agency yearly charge or a 400 —
 * never a charge it chose the amount of.
 */
export const action = async ({ request }) => {
  const { session, billing, redirect } = await authenticate.admin(request);
  const shop = session.shop;
  const token = session.accessToken;
  const version = apiVersion || "2025-10";
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "cancel-plan") {
    return cancelPlan({ billing, shop, token, version });
  }

  if (intent !== "select-plan") {
    return Response.json({ ok: false, error: `Unsupported intent "${intent}"` }, { status: 400 });
  }

  const tier = String(formData.get("plan") || "");
  const interval = String(formData.get("interval") || BILLING_INTERVAL.MONTHLY);
  const planKey = billingPlanKey(tier, interval);

  if (!planKey) {
    return Response.json(
      { ok: false, error: `Unknown or non-billable plan "${tier}" / "${interval}"` },
      { status: 400 },
    );
  }

  const appUrl = process.env.SHOPIFY_APP_URL || ""; // eslint-disable-line no-undef
  const isTest = await isTestCharge({ shopifyGraphql, shop, token, version });
  const trialDays = await trialDaysOverrideFor({ shopifyGraphql, shop, token, version });

  console.log(`[app.billing] requesting charge for ${shop}: plan="${planKey}" isTest=${isTest} trialDays=${trialDays ?? "default"}`);

  try {
    // Always throws. On success it throws a Response that carries the
    // merchant out of the iframe to Shopify's approval screen; on refusal it
    // throws a real error. Both arrive here, so the two must be told apart.
    return await billing.request({
      plan: planKey,
      isTest,
      returnUrl: `${appUrl}/app/billing`,
      // undefined leaves the plan's own 7 days in place; 0 suppresses it for
      // a shop that has already had one. See billing-trial.server.js.
      ...(trialDays === undefined ? {} : { trialDays }),
    });
  } catch (thrown) {
    // The success path. Re-throwing is what actually performs the redirect.
    if (thrown instanceof Response) throw thrown;

    if (isManagedPricingRejection(thrown)) {
      return redirectToHostedPlanPage({ redirect, shop, token, version });
    }

    // describeBillingError, not .message: every billing failure arrives as the
    // same generic "Error while billing the store", with the real reason on
    // errorData. Logging the message alone says nothing.
    console.error(`[app.billing] charge request failed for ${shop} (plan="${planKey}"): ${describeBillingError(thrown)}`);
    return Response.json(
      { ok: false, error: "Shopify could not start that plan change. Please try again." },
      { status: 500 },
    );
  }
};

/**
 * Downgrade to Free — cancel rather than charge.
 *
 * Cancels EVERY active subscription this app holds for the shop, not just the
 * one reconcile() considers current. A merchant who has switched plans
 * repeatedly can legitimately have more than one, and leaving any of them live
 * would keep billing someone this app has just told they are on Free.
 *
 * The loop deliberately does NOT swallow per-subscription failures. If Shopify
 * refuses a cancellation, the local tier must stay paid: writing Free while a
 * charge is still live would strip the merchant's features while they continue
 * to pay for them. Failing the request leaves both sides consistent on the
 * paid plan, which is the recoverable direction.
 *
 * Note Shopify defers a paid -> free downgrade to the end of the current
 * billing cycle, and `prorate: true` credits the unused remainder. Neither is
 * this app's decision to make; both are stated on the confirmation dialog.
 */
async function cancelPlan({ billing, shop, token, version }) {
  const { appSubscriptions } = await billing.check();
  const active = (appSubscriptions || []).filter((s) => tierFromSubscriptionName(s.name));

  if (active.length === 0) {
    const status = await getUsageStatus({ prisma, shop });

    // A complimentary grant also has zero active subscriptions, so it lands
    // here — but "nothing to cancel at Shopify" means something different for
    // it than for a lapsed shop. There is no charge to stop, and the grant is
    // an account decision this app must not let a stray click undo. Say so
    // rather than silently dropping the merchant to Free.
    if (isComplimentary(status.subscriptionStatus)) {
      console.log(`[app.billing] ${shop} attempted to cancel a complimentary ${status.tier} grant — refused`);
      return Response.json(
        { ok: false, error: `Your ${status.label} plan is complimentary — there's no charge to cancel. Contact support if you'd like it changed.` },
        { status: 409 },
      );
    }

    if (status.tier !== PLAN_IDS.FREE) {
      await setShopTier({ prisma, shop, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: null });
    }
    return Response.json({ ok: true, cancelled: 0, alreadyFree: true });
  }

  const isTest = await isTestCharge({ shopifyGraphql, shop, token, version });
  let cancelled = 0;

  try {
    for (const subscription of active) {
      await billing.cancel({ subscriptionId: subscription.id, prorate: true, isTest });
      cancelled += 1;
      console.log(`[app.billing] cancelled subscription ${subscription.id} for ${shop}`);
    }
  } catch (err) {
    console.error(`[app.billing] cancellation failed for ${shop} after ${cancelled} of ${active.length}:`, err?.message);
    return Response.json(
      { ok: false, error: "We couldn't cancel your plan with Shopify. Your current plan is unchanged." },
      { status: 500 },
    );
  }

  await setShopTier({ prisma, shop, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: null });
  console.log(`[app.billing] ${shop} moved to Free (${cancelled} subscription(s) cancelled)`);
  return Response.json({ ok: true, cancelled });
}

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
function AgencyIneligibleNotice({ eligibility, since }) {
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
            the same store contact email, or switch to Pro using the plan cards below.
          </p>
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
};

/**
 * Segmented pill: "Pay monthly" | "Pay yearly (save 20%)".
 *
 * A radiogroup rather than two plain buttons so arrow keys and screen readers
 * treat it as the single control it visually is. Ported from the Citeable
 * Plans page; styling lives in tailwind.css under .iz-period-toggle.
 */
function PeriodToggle({ period, onChange, savings }) {
  return (
    <div className="iz-period-toggle" role="radiogroup" aria-label="Billing period">
      {PERIOD_TOGGLE_OPTIONS.map((option) => {
        const active = period === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.key)}
            className={`iz-period-toggle__option${active ? " iz-period-toggle__option--active" : ""}`}
          >
            {option.label}
            {option.key === BILLING_INTERVAL.YEARLY && savings > 0 && (
              <span className="iz-period-toggle__save">(save {savings}%)</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

PeriodToggle.propTypes = {
  period: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  savings: PropTypes.number,
};

export default function BillingPage() {
  const { usage, eligibility, justSelectedPlan } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const showAgencyNotice = usage.tier === PLAN_IDS.AGENCY && !eligibility.eligible;

  // Drives RedirectingOverlay. Set true the instant a plan is selected —
  // BEFORE the fetcher submits — and only ever cleared on a failed action.
  // See shouldDismissOverlay in billing-ui.js for why it must not track
  // fetcher.state directly.
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Seeded from what the shop is actually billed on, so a merchant already
  // paying yearly does not land on a page quoting them monthly prices — and,
  // more importantly, does not see "Switch to monthly" as the default action
  // on the plan they already hold. Falls back to monthly for Free shops and
  // for the case where Shopify reported no interval.
  const [period, setPeriod] = useState(usage.interval || BILLING_INTERVAL.MONTHLY);

  // Whether the page has been hidden since the overlay went up — see
  // shouldDismissOverlayOnReshow for why becoming visible only counts as a
  // return trip if it was hidden first. A ref, not state: it must not
  // re-render anything, it only qualifies the next event.
  const wasHiddenRef = useRef(false);

  useEffect(() => {
    if (shouldDismissOverlay({ state: fetcher.state, data: fetcher.data })) {
      setOverlayOpen(false);
    }
    if (fetcher.data?.ok === false && fetcher.state === "idle") {
      shopify.toast.show(fetcher.data.error || "Could not complete that plan change", { isError: true });
    }
    // Cancellation is the one action that finishes in-app rather than at
    // Shopify, so it is also the only one that has to report its own success.
    if (fetcher.data?.ok === true && fetcher.state === "idle" && fetcher.data.cancelled !== undefined) {
      shopify.toast.show(
        fetcher.data.alreadyFree
          ? "You're on the Free plan"
          : "Your plan will end at the close of this billing cycle",
      );
    }
  }, [fetcher.data, fetcher.state, shopify]);

  // The overlay has no dismiss control by design, so any path that leaves it
  // up without the navigation happening is a dead end the merchant can only
  // escape by reloading. Back-from-Shopify (bfcache) and a silently dropped
  // App Bridge handoff are both such paths; both end with this page on screen
  // again, which is what clears it.
  useEffect(() => {
    if (!overlayOpen) {
      wasHiddenRef.current = false;
      return undefined;
    }

    const dismissIfReturned = (persisted) => {
      if (shouldDismissOverlayOnReshow({
        persisted,
        visibilityState: document.visibilityState,
        wasHidden: wasHiddenRef.current,
      })) {
        setOverlayOpen(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;
        return;
      }
      dismissIfReturned(false);
    };
    const onPageShow = (event) => dismissIfReturned(event.persisted);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [overlayOpen]);

  // Shopify sends the merchant back here after they pick a plan. The tier
  // shown has already been reconciled from billing.check() by the loader —
  // but that reconciliation can lag or fail soft, so what the toast is
  // allowed to claim depends on it. See planConfirmationToast.
  useEffect(() => {
    const toast = planConfirmationToast({
      planHandle: justSelectedPlan,
      tier: usage.tier,
      label: usage.label,
    });
    if (toast) shopify.toast.show(toast.message);
  }, [justSelectedPlan, usage.tier, usage.label, shopify]);

  function handleSelectPlan(plan, interval) {
    beginPlanSelection({
      plan,
      interval,
      currentTier: usage.tier,
      currentInterval: usage.interval,
      showOverlay: () => setOverlayOpen(true),
      submit: (fields) => fetcher.submit({ intent: "select-plan", ...fields }, { method: "POST" }),
    });
  }

  // Cancelling is the one action here with no Shopify approval screen behind
  // it, so this dialog IS the confirmation step. See CANCEL_CONFIRM_COPY.
  function handleCancelPlan() {
    setConfirmCancel(true);
  }

  function confirmCancelPlan() {
    setConfirmCancel(false);
    // No overlay: nothing leaves the page, so there is no navigation gap to
    // cover. The fetcher's own busy state disables the buttons.
    fetcher.submit({ intent: "cancel-plan" }, { method: "POST" });
  }

  return (
    <s-page heading="Billing" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <RedirectingOverlay
        open={overlayOpen}
        title={REDIRECT_OVERLAY_COPY.title}
        timing={REDIRECT_OVERLAY_COPY.timing}
        reassurance={REDIRECT_OVERLAY_COPY.reassurance}
      />

      {confirmCancel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-[2px] animate-fade-in"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cancel-confirm-title"
          aria-describedby="cancel-confirm-body"
        >
          <div className="bg-white rounded-xl shadow-xl border border-gray-200 max-w-sm w-full p-6">
            <p id="cancel-confirm-title" className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
              {CANCEL_CONFIRM_COPY.title}
            </p>
            <div id="cancel-confirm-body">
              <p className="mt-2 text-xs text-gray-600 leading-relaxed">
                {CANCEL_CONFIRM_COPY.body}
              </p>

              {/* Spelled out from the two plans' own feature lists, so "are
                  you sure?" is an informed question rather than a dare. */}
              <p className="mt-3 text-xs font-semibold text-gray-900" style={{ fontFamily: F }}>
                You&apos;ll lose access to
              </p>
              <ul className="mt-1.5 space-y-1">
                {planFeatures(PLANS[usage.tier])
                  .filter((f) => !planFeatures(PLANS[PLAN_IDS.FREE]).includes(f))
                  .map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-xs text-gray-600">
                      <span className="text-gray-300 mt-px">•</span>
                      <span>{f}</span>
                    </li>
                  ))}
              </ul>

              {/* The concrete consequence for THIS shop, not a generic
                  warning: a merchant already over the Free limit needs to
                  know before they choose, not after. */}
              {usage.used > PLANS[PLAN_IDS.FREE].recordLimit && (
                <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5 leading-relaxed">
                  You&apos;ve imported {usage.used.toLocaleString()} records this month. Free includes{" "}
                  {PLANS[PLAN_IDS.FREE].recordLimit.toLocaleString()} — imports already completed stay,
                  but you won&apos;t be able to run new ones until next month.
                </p>
              )}
            </div>
            <div className="mt-4 flex gap-2 justify-end flex-wrap">
              <button
                type="button"
                onClick={() => setConfirmCancel(false)}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
                style={{ fontFamily: F }}
              >
                {CANCEL_CONFIRM_COPY.dismiss}
              </button>
              <button
                type="button"
                onClick={confirmCancelPlan}
                className="px-3 py-2 text-xs font-semibold rounded-lg text-white hover:brightness-110"
                style={{ background: "#dc2626", fontFamily: F }}
              >
                {CANCEL_CONFIRM_COPY.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
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
          />
        )}

        <section className="space-y-4">
          <div className="text-center">
            <h2 className="text-lg font-semibold text-gray-900" style={{ fontFamily: F }}>Plans &amp; Pricing</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-xl mx-auto">
              Pick your plan and billing period here. Shopify shows one approval screen for that exact
              charge and brings you straight back — downgrading happens without leaving the app.
            </p>
          </div>

          {/* Billing period toggle, centred above the cards. One control for
              the whole grid, so each card shows a single price. */}
          <div className="flex justify-center">
            <PeriodToggle period={period} onChange={setPeriod} savings={yearlySavingsPercent(PLAN_IDS.PRO)} />
          </div>

          <div className="iz-plan-grid grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
            {/* Order and emphasis both depend on this shop's eligibility:
                the best-fit plan is featured and sits in the middle. */}
            {planDisplayOrder(eligibility).map((id) => (
              <PlanCard
                key={id}
                plan={PLANS[id]}
                currentTier={usage.tier}
                currentInterval={usage.interval}
                period={period}
                eligibility={eligibility}
                onSelect={(interval) => handleSelectPlan(PLANS[id], interval)}
                onCancel={handleCancelPlan}
                busy={busy}
                featured={isFeaturedPlan(id, eligibility)}
              />
            ))}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>All plans include</h3>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {ALL_PLANS_INCLUDE.map((label) => (
                <span key={label} className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                  <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" style={{ color: S }} aria-hidden="true">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                  {label}
                </span>
              ))}
            </div>
          </div>

          <p className="text-xs text-gray-400 text-center">
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
