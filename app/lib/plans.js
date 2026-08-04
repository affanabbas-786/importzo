// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Billing plan definitions.
//
// Pure data/helpers only (no Prisma, no Shopify client) so this can be
// imported from both server code (shopify.server.js billing config,
// usage.server.js) and client-rendered route components (app.billing.jsx,
// app.settings.jsx) that need to show a price/limit/tagline — unlike
// *.server.js files, this one is NOT stripped from the client bundle.
//
// This is the single source of truth for prices/limits. Nothing else in the
// app should hard-code a "15", "10", or a record limit.
// ═══════════════════════════════════════════════════════════════════

export const PLAN_IDS = Object.freeze({
  FREE: "free",
  PRO: "pro",
  AGENCY: "agency",
});

// The exact name Shopify shows the merchant on the charge confirmation page
// and in their billing history (appSubscriptionCreate's `name` argument —
// see shopify.server.js's `billing` config, keyed by these same strings).
// Treat as stable once live: renaming creates a new-looking charge rather
// than continuing the existing one.
export const SHOPIFY_PLAN_NAME = Object.freeze({
  pro: "Importzo Pro",
  agency: "Importzo Agency",
});

// Minimum distinct, currently-installed stores (same merchant, matched by
// shop owner email, counting the current store itself) required to unlock
// Agency pricing. See agency-eligibility.server.js.
export const AGENCY_MIN_STORES = 3;

// Monthly cap on Importzo's built-in AI (Groq) calls, shared across every
// built-in-AI feature combined (SEO cleanup, alt-text, duplicate detection,
// error diagnosis) — not per feature. Bring-your-own-key usage never counts
// against this; it's the merchant's own credential and cost. See
// usage.server.js's getAiUsageStatus/recordAiUsage.
export const AI_MONTHLY_CALL_CAP = 500;

// Free has no Shopify AppSubscription at all — Shopify doesn't support a $0
// recurring charge — so "Free" is just the absence of an active paid
// subscription, tracked only in ShopPlan.tier locally.
export const PLANS = Object.freeze({
  [PLAN_IDS.FREE]: {
    id: PLAN_IDS.FREE,
    label: "Free",
    price: 0,
    recordLimit: 250,
    scheduledSync: false,
    builtInAi: false,
    shopifyPlanName: null,
    tagline: "1 store, 250 records/month",
    description: "For trying Importzo out on a single store.",
  },
  [PLAN_IDS.PRO]: {
    id: PLAN_IDS.PRO,
    label: "Pro",
    price: 15,
    recordLimit: Infinity,
    scheduledSync: true,
    builtInAi: true,
    shopifyPlanName: SHOPIFY_PLAN_NAME.pro,
    tagline: "Unlimited records + scheduled sync",
    description: "For growing stores that need unlimited volume and recurring sync.",
  },
  [PLAN_IDS.AGENCY]: {
    id: PLAN_IDS.AGENCY,
    label: "Agency",
    price: 10,
    recordLimit: Infinity,
    scheduledSync: true,
    builtInAi: true,
    shopifyPlanName: SHOPIFY_PLAN_NAME.agency,
    tagline: "Everything in Pro, discounted per store",
    description: `Unlocks once the same merchant has ${AGENCY_MIN_STORES}+ stores running Importzo.`,
    requiresEligibility: true,
  },
});

export const PLAN_ORDER = [PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY];

export function isValidPlanId(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, id);
}

export function getPlan(id) {
  return PLANS[id] || PLANS[PLAN_IDS.FREE];
}

export function isUnlimited(tier) {
  return getPlan(tier).recordLimit === Infinity;
}

export function scheduledSyncAllowed(tier) {
  return !!getPlan(tier).scheduledSync;
}

export function builtInAiAllowed(tier) {
  return !!getPlan(tier).builtInAi;
}

// Paid, billable plans in the sense of "requires a Shopify AppSubscription".
// Free is deliberately excluded — see PLANS.free.shopifyPlanName.
export function isBillablePlanId(id) {
  return isValidPlanId(id) && id !== PLAN_IDS.FREE;
}
