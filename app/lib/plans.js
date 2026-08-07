// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Billing plan definitions.
//
// Pure data/helpers only (no Prisma, no Shopify client) so this can be
// imported from both server code (usage.server.js, app-pricing.server.js)
// and client-rendered route components (app.billing.jsx, app.settings.jsx)
// that need to show a price/limit/tagline — unlike *.server.js files, this
// one is NOT stripped from the client bundle.
//
// This is the single source of truth for prices/limits. Nothing else in the
// app should hard-code a "15", "10", "144", "96", or a record limit.
//
// Phase 8 — the app is now on Shopify App Pricing (formerly "Managed
// Pricing"): the amounts below are entered in the Partner Dashboard and
// Shopify owns the charge. The values here are DISPLAY COPY that must be
// kept in step with the dashboard by hand — changing a number here does not
// change what a merchant is billed, and changing the dashboard does not
// change what this app says. See app-pricing.server.js.
// ═══════════════════════════════════════════════════════════════════

export const PLAN_IDS = Object.freeze({
  FREE: "free",
  PRO: "pro",
  AGENCY: "agency",
});

// Display names for the two paid tiers. Under Shopify App Pricing the
// authoritative plan name is whatever the Partner Dashboard says, and this
// app can no longer set it (it used to be appSubscriptionCreate's `name`).
// These are still what the app CALLS the tiers in its own UI; matching an
// incoming subscription back to a tier goes through tierFromSubscriptionName
// below, which deliberately does not require an exact match against these.
export const SHOPIFY_PLAN_NAME = Object.freeze({
  pro: "Importzo Pro",
  agency: "Importzo Agency",
});

// Free-trial length on both paid plans. Configured per-plan in the Partner
// Dashboard now; repeated here only so the UI can say "7-day free trial"
// without hard-coding a 7 in three components.
export const TRIAL_DAYS = 7;

export const BILLING_INTERVAL = Object.freeze({
  MONTHLY: "monthly",
  YEARLY: "yearly",
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
    priceYearly: 0,
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
    priceYearly: 144,
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
    priceYearly: 96,
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

/**
 * Whole-percent saving of the yearly price versus paying monthly for 12
 * months. Computed rather than stored so the "save 20%" copy can never drift
 * out of step with the two numbers it's derived from — if a price changes and
 * the discount is no longer 20%, every surface that shows it changes together.
 * Returns 0 for Free (and for any plan with no yearly option).
 */
export function yearlySavingsPercent(id) {
  const plan = getPlan(id);
  const monthlyTotal = plan.price * 12;
  if (!monthlyTotal || !plan.priceYearly) return 0;
  return Math.round((1 - plan.priceYearly / monthlyTotal) * 100);
}

/** True when this plan can be paid for annually as well as monthly. */
export function hasYearlyOption(id) {
  return getPlan(id).priceYearly > 0;
}

// Maps a Shopify AppSubscription's `name` back to one of this app's tiers.
//
// Under the Billing API this app chose the subscription name itself, so an
// exact lookup against SHOPIFY_PLAN_NAME was safe. Under Shopify App Pricing
// the name comes from whatever the plan is called in the Partner Dashboard,
// per published language, and each plan now has a monthly AND a yearly
// variant that Shopify may name separately ("Pro", "Pro Annual", "Importzo
// Pro (Yearly)"). An exact match would silently fail to recognise a real,
// paid subscription and drop the merchant to Free — the worst possible
// failure mode here — so this matches on the tier keyword instead.
//
// Agency is tested first: it is the more specific term, and a plan named
// "Agency Pro" should be read as Agency, not Pro.
const TIER_KEYWORDS = [
  [PLAN_IDS.AGENCY, /agency/i],
  [PLAN_IDS.PRO, /\bpro/i],
];

export function tierFromSubscriptionName(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  for (const [tier, pattern] of TIER_KEYWORDS) {
    if (pattern.test(name)) return tier;
  }
  return null;
}

// Shopify's AppRecurringPricing.interval enum -> this app's vocabulary.
// ANNUAL and EVERY_30_DAYS are the only two values the plans above use.
export function intervalFromShopifyInterval(interval) {
  if (typeof interval !== "string") return null;
  if (interval.toUpperCase() === "ANNUAL") return BILLING_INTERVAL.YEARLY;
  if (interval.toUpperCase() === "EVERY_30_DAYS") return BILLING_INTERVAL.MONTHLY;
  return null;
}
