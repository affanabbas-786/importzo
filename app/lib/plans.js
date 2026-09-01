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
// Phase 8 — under Shopify App Pricing these amounts were DISPLAY COPY only:
// the Partner Dashboard held the real numbers and Shopify owned the charge.
//
// Phase 10 — that is no longer true, and the difference is money. The app
// charges directly again (appSubscriptionCreate, via the `billing` config in
// shopify.server.js), and that config is built from the amounts below. A
// number changed here now changes what a merchant is actually billed on their
// next subscribe. Treat every edit in this file as a pricing change, not a
// copy change. test/lib/plans.test.js pins the current values precisely so
// that an accidental edit fails loudly rather than quietly re-pricing the app.
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
    // Phase 12 — a Free store cannot fund partner stores. Only a genuinely
    // paid tier (Pro/Agency) can be a payer — see partner-linking.server.js.
    maxPartners: 0,
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
    // 1 partner slot included at no extra charge — Pro's price never varies
    // with partner count, unlike Agency's.
    maxPartners: 1,
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
    // Up to 5 partner slots, each adding AGENCY_PARTNER_PRICE/month — see
    // agencyPartnerPrice below.
    maxPartners: 5,
  },
});

/** Max linked-partner slots this tier's price includes room for. */
export function maxPartnersFor(tier) {
  return getPlan(tier).maxPartners || 0;
}

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

// ═══════════════════════════════════════════════════════════════════
// Phase 10 — Manual Billing API plan keys.
//
// Under App Pricing there was ONE hosted page and no per-plan path, so the
// app never had to name a specific charge. Charging directly means naming
// exactly one of four things, and the tier alone is not enough: Pro monthly
// and Pro yearly are separate AppSubscriptions at different prices.
//
// These strings are the keys of the `billing` config in shopify.server.js AND
// the `name` Shopify stores on the subscription it creates. That dual role is
// why they matter beyond bookkeeping: reconcile() reads the name back off the
// subscription and runs it through tierFromSubscriptionName below to recover
// the tier. Every name here is deliberately chosen to still match those
// keyword patterns — "Importzo Pro Monthly" contains "Pro", "Importzo Agency
// Yearly" contains "Agency" — so the existing reconciliation keeps working
// unchanged, including for subscriptions created by App Pricing before the
// migration. Renaming one of these without checking that is how a paying
// merchant silently becomes Free.
// ═══════════════════════════════════════════════════════════════════
export const BILLING_PLAN_KEY = Object.freeze({
  [PLAN_IDS.PRO]: Object.freeze({
    [BILLING_INTERVAL.MONTHLY]: "Importzo Pro Monthly",
    [BILLING_INTERVAL.YEARLY]: "Importzo Pro Yearly",
  }),
  [PLAN_IDS.AGENCY]: Object.freeze({
    [BILLING_INTERVAL.MONTHLY]: "Importzo Agency Monthly",
    [BILLING_INTERVAL.YEARLY]: "Importzo Agency Yearly",
  }),
});

/**
 * Tier + interval -> the billing config key to charge against.
 *
 * Returns null for anything that is not a real, billable combination — Free
 * (no charge exists), an unknown tier, or an unknown interval. Callers treat
 * null as "reject this request" rather than falling back to a default, because
 * every possible default here is a wrong amount of money.
 */
export function billingPlanKey(tier, interval) {
  return BILLING_PLAN_KEY[tier]?.[interval] || null;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 12 — Agency per-partner pricing.
//
// Shopify's Billing API has no mutation that silently changes an existing
// recurring subscription's price — any change requires a fresh
// appSubscriptionCreate the merchant approves on Shopify's own screen (see
// app.partners.jsx). Because the partner count is capped at 5
// (PLANS.agency.maxPartners), every possible price is one of a small,
// FIXED set of points, so — exactly like the base Pro/Agency prices above —
// each is pre-registered as its own named plan in shopify.server.js's
// BILLING_CONFIG rather than requesting an ad-hoc dynamic amount. A count
// this app never reaches (6+) is deliberately NOT generated here; the cap
// itself is enforced in partner-linking.server.js before any price is ever
// computed for billing purposes.
// ═══════════════════════════════════════════════════════════════════

// USD/month added to the Agency base price per linked partner store.
export const AGENCY_PARTNER_ADDON = 7;

/**
 * Agency's price at a given linked-partner count. Monthly is the base price
 * plus the flat per-partner add-on; yearly reuses the SAME discount ratio as
 * the base Agency yearly price (derived from it, not a second hardcoded
 * percentage) so the two can never quietly drift apart.
 */
export function agencyPartnerPrice(partnerCount, interval = BILLING_INTERVAL.MONTHLY) {
  const base = getPlan(PLAN_IDS.AGENCY);
  const count = Number(partnerCount) || 0;
  const monthly = base.price + AGENCY_PARTNER_ADDON * count;
  if (interval !== BILLING_INTERVAL.YEARLY) return monthly;
  const discountRatio = base.priceYearly / (base.price * 12);
  return Math.round(monthly * 12 * discountRatio);
}

/**
 * The BILLING_CONFIG key for Agency at a given partner count.
 *
 * Zero partners reuses today's existing base Agency key/price unchanged —
 * only counts 1+ generate a new discrete key. Every generated name still
 * contains "Agency" (it's built from the base key), so tierFromSubscriptionName
 * below keeps recognising these subscriptions as Agency with no changes.
 */
export function agencyPartnerBillingPlanKey(partnerCount, interval) {
  const base = BILLING_PLAN_KEY[PLAN_IDS.AGENCY]?.[interval];
  if (!base) return null;
  const count = Number(partnerCount) || 0;
  if (count === 0) return base;
  return `${base} — ${count} Partner${count === 1 ? "" : "s"}`;
}

/** The price a given tier+interval actually charges, for confirmation copy. */
export function priceFor(tier, interval) {
  const plan = getPlan(tier);
  if (interval === BILLING_INTERVAL.YEARLY) return plan.priceYearly;
  return plan.price;
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

// ═══════════════════════════════════════════════════════════════════
// Complimentary grants — a paid tier handed out with no Shopify charge.
//
// Occasionally a shop is put on a paid tier for free and permanently (a
// partner, a design-partner store, goodwill after an incident). There is no
// Shopify AppSubscription behind it, because Shopify has no way to represent
// "paid plan, $0, forever" — and that absence is the problem this constant
// solves.
//
// Every path that reconciles local tier against Shopify reads "no active
// subscription" as "this merchant's charge lapsed" and writes Free. For a
// complimentary shop that inference is wrong, and it fires silently on the
// merchant's next Billing page load, so the grant would quietly evaporate
// days after being made.
//
// The marker lives in ShopPlan.subscriptionStatus rather than a new column:
// that field is already "whatever Shopify last said about the subscription",
// it is free text with no format validation anywhere in the app, and it is
// exactly the field the downgrade paths already carry. Reusing it keeps the
// grant self-describing in the row itself, with no schema migration.
//
// subscriptionId stays NULL for these shops — there is genuinely no
// subscription to point at, and inventing a GID would make the row lie to
// anything that later tries to cancel or query it.
//
// A complimentary grant is only ever cleared deliberately, by setting the
// tier back by hand. No automatic path may downgrade it.
export const COMPLIMENTARY_STATUS = "COMPLIMENTARY";

/**
 * Whether this shop is on a complimentary (unbilled, permanent) grant.
 *
 * Takes the status string rather than the row so it can be called from both
 * a ShopPlan record and a usage status object without either shape leaking
 * into this module.
 */
export function isComplimentary(subscriptionStatus) {
  return subscriptionStatus === COMPLIMENTARY_STATUS;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 12 — Partner-linked grants — Pro access funded by another shop's
// (the payer's) Shopify subscription instead of this shop's own.
//
// Structurally the same shape as COMPLIMENTARY_STATUS above: no Shopify
// AppSubscription exists for this shop (subscriptionId stays NULL), so the
// same "no active subscription is not evidence of a lapsed charge" problem
// applies, and it's solved the same way — a marker in subscriptionStatus
// that every reconciliation path checks before inferring a downgrade. See
// partner-linking.server.js for how the grant is created/revoked.
// ═══════════════════════════════════════════════════════════════════
export const PARTNER_LINKED_STATUS = "PARTNER_LINKED";

/** Whether this shop's Pro access is funded by a payer's subscription. */
export function isPartnerLinked(subscriptionStatus) {
  return subscriptionStatus === PARTNER_LINKED_STATUS;
}
