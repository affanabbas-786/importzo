import { useEffect } from "react";
import PropTypes from "prop-types";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { getOrCreateShopPlan, getUsageStatus, setShopTier } from "../lib/usage.server";
import { checkAgencyEligibility } from "../lib/agency-eligibility.server";
import { PLAN_IDS, PLANS, PLAN_ORDER, SHOPIFY_PLAN_NAME, AGENCY_MIN_STORES, isBillablePlanId } from "../lib/plans.js";
import { BRAND } from "../lib/constants";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Billing: plan-selection UI + Shopify AppSubscription wiring.
//
// ShopPlan.tier (usage.server.js) is the value every write path actually
// enforces against, and it's only ever changed here (plus the Free default
// on first install) — via reconcile() in the loader, which is the single
// place Shopify's billing state gets translated into a local tier. Without
// this route, ShopPlan.tier could never leave "free": nothing else in the
// app calls setShopTier with a real subscription.
// ═══════════════════════════════════════════════════════════════════

const NAME_TO_TIER = Object.freeze({
  [SHOPIFY_PLAN_NAME.pro]: PLAN_IDS.PRO,
  [SHOPIFY_PLAN_NAME.agency]: PLAN_IDS.AGENCY,
});

// Every paid tier request goes through Shopify's *test* charge mode outside
// production — see shopify.server.js's `billing` config, which fixes the
// currency/amount; this only controls whether a real card gets charged.
function isTestCharge() {
  return process.env.NODE_ENV !== "production"; // eslint-disable-line no-undef
}

/**
 * Reconciles ShopPlan.tier against Shopify's actual AppSubscription state.
 * The merchant can approve or cancel a charge from places this app never
 * sees a request for (Shopify's own billing settings, an email link), so
 * local tier can drift from reality — this is the point where it's pulled
 * back in sync, on every Billing page load.
 */
async function reconcile({ billing, shop }) {
  const { appSubscriptions } = await billing.check();
  const active = appSubscriptions.find((s) => NAME_TO_TIER[s.name]);

  if (active) {
    return setShopTier({
      prisma, shop, tier: NAME_TO_TIER[active.name],
      subscriptionId: active.id, subscriptionStatus: active.status,
    });
  }

  // No active Shopify subscription. If this shop is still marked paid
  // locally, the charge lapsed or was cancelled outside this app — drop
  // back to Free rather than keep enforcing a paid shop's limits/features
  // for a subscription that no longer exists.
  const current = await getUsageStatus({ prisma, shop });
  if (current.tier === PLAN_IDS.FREE) return current;
  return setShopTier({ prisma, shop, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: null });
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
    usage = await getUsageStatus({ prisma, shop });
  }

  const eligibility = await checkAgencyEligibility({
    prisma, shopifyGraphql, shop, token: session.accessToken, version,
  });

  return { usage, eligibility, isTestCharge: isTestCharge() };
};

export const action = async ({ request }) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const version = apiVersion || "2025-10";
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "subscribe") {
    return Response.json({ ok: false, error: `Unsupported intent "${intent}"` }, { status: 400 });
  }

  const plan = formData.get("plan");
  if (!isBillablePlanId(plan)) {
    return Response.json({ ok: false, error: `Unknown plan "${plan}"` }, { status: 400 });
  }

  if (plan === PLAN_IDS.AGENCY) {
    // The UI already hides/disables Agency for an ineligible shop, but a
    // raw POST must not be able to skip the store-count requirement.
    // checkAgencyEligibility persists the fetched email onto THIS shop's own
    // row (needed for it to count itself), which requires that row to
    // already exist — normally true by the time a merchant can click
    // Subscribe (the loader's reconcile() creates it on page load), but not
    // guaranteed for a direct POST, so it's created here too.
    await getOrCreateShopPlan({ prisma, shop });
    const eligibility = await checkAgencyEligibility({
      prisma, shopifyGraphql, shop, token: session.accessToken, version,
    });
    if (!eligibility.eligible) {
      return Response.json({
        ok: false,
        error: `Agency requires ${AGENCY_MIN_STORES}+ stores running Importzo (this merchant currently has ${eligibility.storeCount}).`,
      }, { status: 403 });
    }
  }

  const appUrl = (process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/+$/, ""); // eslint-disable-line no-undef

  // billing.request always throws — either a redirect (non-embedded) or,
  // for an embedded/XHR request like this fetcher submission, a response
  // App Bridge's patched fetch recognizes and turns into a top-level
  // redirect to Shopify's charge confirmation page. There is no line of
  // code after this that will ever run on success.
  await billing.request({
    plan: SHOPIFY_PLAN_NAME[plan],
    isTest: isTestCharge(),
    trialDays: 7,
    returnUrl: `${appUrl}/app/billing`,
  });

  return null;
};

const { primary: P, secondary: S, font: F } = BRAND;

function UsageCard({ usage }) {
  const pct = usage.isUnlimited ? 0 : Math.min(100, Math.round((usage.used / Math.max(usage.limit, 1)) * 100));
  const atLimit = !usage.isUnlimited && usage.remaining === 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">Current plan: {usage.label}</p>
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
  }).isRequired,
};

function PlanCard({ plan, currentTier, eligibility, isTestCharge, onSubscribe, busy }) {
  const isCurrent = plan.id === currentTier;
  const isFree = plan.id === PLAN_IDS.FREE;
  const needsEligibility = plan.requiresEligibility && !eligibility.eligible;

  return (
    <div
      className="bg-white rounded-xl border shadow-sm p-5 flex flex-col"
      style={{ borderColor: isCurrent ? S : "#e5e7eb", borderWidth: isCurrent ? 2 : 1 }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>{plan.label}</p>
        {isCurrent && (
          <span className="text-xs font-semibold px-2 py-1 rounded-full flex-shrink-0" style={{ background: "rgba(46,99,22,0.1)", color: S }}>
            Current plan
          </span>
        )}
      </div>
      <p className="mt-1 text-2xl font-bold text-gray-900" style={{ fontFamily: F }}>
        {plan.price === 0 ? "Free" : `$${plan.price}`}
        {plan.price > 0 && <span className="text-sm font-medium text-gray-400">/mo{plan.requiresEligibility ? " per store" : ""}</span>}
      </p>
      <p className="mt-1 text-xs text-gray-500">{plan.tagline}</p>
      <p className="mt-2 text-xs text-gray-500 leading-relaxed flex-1">{plan.description}</p>

      {needsEligibility && (
        <p className="mt-3 text-[11px] text-amber-600 font-medium">
          Unlocks at {AGENCY_MIN_STORES}+ stores — this merchant currently has {eligibility.storeCount}.
        </p>
      )}

      {!isFree && !isCurrent && (
        <button
          type="button"
          disabled={busy || needsEligibility}
          onClick={() => onSubscribe(plan.id)}
          className="mt-4 px-4 py-2 text-sm rounded-lg shadow-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110"
          style={{ background: needsEligibility ? "#d1d5db" : P, color: "#fff", fontFamily: F }}
        >
          {busy ? "Redirecting…" : `Subscribe to ${plan.label}`}
        </button>
      )}

      {!isFree && !isCurrent && !needsEligibility && (
        <p className="mt-2 text-[11px] text-gray-400">7-day free trial{isTestCharge ? " · test charge, no real card is billed" : ""}</p>
      )}
    </div>
  );
}

PlanCard.propTypes = {
  plan: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    price: PropTypes.number,
    tagline: PropTypes.string,
    description: PropTypes.string,
    requiresEligibility: PropTypes.bool,
  }).isRequired,
  currentTier: PropTypes.string.isRequired,
  eligibility: PropTypes.shape({
    eligible: PropTypes.bool,
    storeCount: PropTypes.number,
  }).isRequired,
  isTestCharge: PropTypes.bool.isRequired,
  onSubscribe: PropTypes.func.isRequired,
  busy: PropTypes.bool.isRequired,
};

export default function BillingPage() {
  const { usage, eligibility, isTestCharge } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok === false && fetcher.state === "idle") {
      shopify.toast.show(fetcher.data.error || "Could not start checkout", { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  function handleSubscribe(planId) {
    fetcher.submit({ intent: "subscribe", plan: planId }, { method: "POST" });
  }

  return (
    <s-page heading="Billing" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }}>Billing</span>
        </div>

        <UsageCard usage={usage} />

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>Plans</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Upgrading takes effect as soon as you approve the charge in Shopify. To cancel or change
              payment details, use Shopify admin&apos;s Apps &amp; sales channels &rarr; Manage app &rarr; Billing.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {PLAN_ORDER.map((id) => (
              <PlanCard
                key={id}
                plan={PLANS[id]}
                currentTier={usage.tier}
                eligibility={eligibility}
                isTestCharge={isTestCharge}
                onSubscribe={handleSubscribe}
                busy={busy}
              />
            ))}
          </div>
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
