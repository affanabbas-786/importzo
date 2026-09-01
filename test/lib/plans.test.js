import { describe, it, expect } from "vitest";
import {
  PLANS, PLAN_IDS, PLAN_ORDER, TRIAL_DAYS, BILLING_INTERVAL,
  yearlySavingsPercent, hasYearlyOption,
  tierFromSubscriptionName, intervalFromShopifyInterval,
  agencyPartnerPrice, agencyPartnerBillingPlanKey, AGENCY_PARTNER_ADDON,
} from "../../app/lib/plans.js";

// ═══════════════════════════════════════════════════════════════════
// plans.js is display copy that must stay in step with the Partner
// Dashboard by hand — changing a number here does not change what a
// merchant is billed. These tests pin the numbers the marketing site, the
// Billing page and the upgrade prompts all quote, so a drift shows up as a
// failure rather than as a wrong price in front of a customer.
// ═══════════════════════════════════════════════════════════════════

describe("plans — finalized pricing", () => {
  it("matches the pricing live in the Shopify App Pricing dashboard", () => {
    expect(PLANS[PLAN_IDS.FREE]).toMatchObject({ price: 0, priceYearly: 0, recordLimit: 250 });
    expect(PLANS[PLAN_IDS.PRO]).toMatchObject({ price: 15, priceYearly: 144 });
    expect(PLANS[PLAN_IDS.AGENCY]).toMatchObject({ price: 10, priceYearly: 96 });
  });

  it("gives both paid tiers unlimited records", () => {
    expect(PLANS[PLAN_IDS.PRO].recordLimit).toBe(Infinity);
    expect(PLANS[PLAN_IDS.AGENCY].recordLimit).toBe(Infinity);
  });

  it("offers a 7-day trial", () => {
    expect(TRIAL_DAYS).toBe(7);
  });

  it("gates Agency on eligibility and nothing else", () => {
    expect(PLANS[PLAN_IDS.AGENCY].requiresEligibility).toBe(true);
    expect(PLANS[PLAN_IDS.PRO].requiresEligibility).toBeFalsy();
  });

  it("lists plans cheapest-first for the pricing grid", () => {
    expect(PLAN_ORDER).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
  });
});

describe("yearlySavingsPercent", () => {
  // The "save 20%" badge on the landing page and in-app copy is derived,
  // never typed — if a price moves and the discount is no longer 20%, every
  // surface that quotes it moves together.
  it("computes the advertised 20% saving for both paid plans", () => {
    expect(yearlySavingsPercent(PLAN_IDS.PRO)).toBe(20);    // 144 vs 15*12=180
    expect(yearlySavingsPercent(PLAN_IDS.AGENCY)).toBe(20); // 96  vs 10*12=120
  });

  it("returns 0 for Free, which has no yearly option to discount", () => {
    expect(yearlySavingsPercent(PLAN_IDS.FREE)).toBe(0);
  });

  it("reports which plans can be paid annually", () => {
    expect(hasYearlyOption(PLAN_IDS.PRO)).toBe(true);
    expect(hasYearlyOption(PLAN_IDS.AGENCY)).toBe(true);
    expect(hasYearlyOption(PLAN_IDS.FREE)).toBe(false);
  });
});

describe("tierFromSubscriptionName", () => {
  // Under App Pricing the subscription name comes from the Partner
  // Dashboard, in the merchant's language, with monthly/yearly potentially
  // named separately. Failing to match a real paid subscription would drop a
  // paying merchant to Free — the worst failure mode available here.
  it.each([
    "Importzo Pro", "Pro", "PRO", "Pro Annual", "Importzo Pro (Yearly)", "Importzo Pro — Monthly",
  ])("matches %j to pro", (name) => {
    expect(tierFromSubscriptionName(name)).toBe(PLAN_IDS.PRO);
  });

  it.each([
    "Importzo Agency", "Agency", "agency yearly", "Importzo Agency (Annual)",
  ])("matches %j to agency", (name) => {
    expect(tierFromSubscriptionName(name)).toBe(PLAN_IDS.AGENCY);
  });

  it("prefers Agency when a name contains both words", () => {
    expect(tierFromSubscriptionName("Agency Pro")).toBe(PLAN_IDS.AGENCY);
  });

  it("returns null for a name that matches no tier", () => {
    expect(tierFromSubscriptionName("Enterprise")).toBeNull();
    expect(tierFromSubscriptionName("")).toBeNull();
    expect(tierFromSubscriptionName(null)).toBeNull();
    expect(tierFromSubscriptionName(undefined)).toBeNull();
  });

  // \bpro is word-anchored so an unrelated plan name containing "pro" as a
  // substring doesn't get promoted to a paid tier.
  it("does not match 'pro' buried inside an unrelated word", () => {
    expect(tierFromSubscriptionName("Approved")).toBeNull();
  });
});

// Phase 12 — Partner/Agency linking. Same reasoning as the block above:
// these are the exact numbers a merchant is charged, pinned so a formula
// tweak that silently re-prices the app fails loudly here first.
describe("agencyPartnerPrice", () => {
  it("adds $7/month per linked partner on top of the $10 Agency base", () => {
    expect(AGENCY_PARTNER_ADDON).toBe(7);
    expect(agencyPartnerPrice(0, BILLING_INTERVAL.MONTHLY)).toBe(10);
    expect(agencyPartnerPrice(1, BILLING_INTERVAL.MONTHLY)).toBe(17);
    expect(agencyPartnerPrice(3, BILLING_INTERVAL.MONTHLY)).toBe(31);
    expect(agencyPartnerPrice(5, BILLING_INTERVAL.MONTHLY)).toBe(45);
  });

  it("defaults to monthly when no interval is given", () => {
    expect(agencyPartnerPrice(2)).toBe(24);
  });

  it("applies the SAME discount ratio as the base Agency yearly price (96 vs 120 = 20% off)", () => {
    expect(agencyPartnerPrice(0, BILLING_INTERVAL.YEARLY)).toBe(96); // matches PLANS.agency.priceYearly exactly
    expect(agencyPartnerPrice(1, BILLING_INTERVAL.YEARLY)).toBe(163); // 17*12*0.8 = 163.2 -> 163
    expect(agencyPartnerPrice(2, BILLING_INTERVAL.YEARLY)).toBe(230); // 24*12*0.8 = 230.4 -> 230
    expect(agencyPartnerPrice(3, BILLING_INTERVAL.YEARLY)).toBe(298); // 31*12*0.8 = 297.6 -> 298
    expect(agencyPartnerPrice(4, BILLING_INTERVAL.YEARLY)).toBe(365); // 38*12*0.8 = 364.8 -> 365
    expect(agencyPartnerPrice(5, BILLING_INTERVAL.YEARLY)).toBe(432); // 45*12*0.8 = 432.0 -> 432
  });
});

describe("agencyPartnerBillingPlanKey", () => {
  it("reuses the existing base Agency key, unchanged, for zero partners", () => {
    expect(agencyPartnerBillingPlanKey(0, BILLING_INTERVAL.MONTHLY)).toBe("Importzo Agency Monthly");
    expect(agencyPartnerBillingPlanKey(0, BILLING_INTERVAL.YEARLY)).toBe("Importzo Agency Yearly");
  });

  it("generates a distinct, singular/plural-correct key per partner count", () => {
    expect(agencyPartnerBillingPlanKey(1, BILLING_INTERVAL.MONTHLY)).toBe("Importzo Agency Monthly — 1 Partner");
    expect(agencyPartnerBillingPlanKey(3, BILLING_INTERVAL.MONTHLY)).toBe("Importzo Agency Monthly — 3 Partners");
    expect(agencyPartnerBillingPlanKey(5, BILLING_INTERVAL.YEARLY)).toBe("Importzo Agency Yearly — 5 Partners");
  });

  // The whole point of building these as named-key extensions of the base
  // Agency key: app.billing.jsx's reconciliation must keep recognising them
  // as Agency with NO changes, since it matches on a keyword, not an exact
  // name.
  it("every generated key still round-trips through tierFromSubscriptionName as agency", () => {
    for (let count = 0; count <= PLANS[PLAN_IDS.AGENCY].maxPartners; count++) {
      for (const interval of [BILLING_INTERVAL.MONTHLY, BILLING_INTERVAL.YEARLY]) {
        const key = agencyPartnerBillingPlanKey(count, interval);
        expect(tierFromSubscriptionName(key)).toBe(PLAN_IDS.AGENCY);
      }
    }
  });
});

describe("intervalFromShopifyInterval", () => {
  it("maps Shopify's enum onto this app's vocabulary", () => {
    expect(intervalFromShopifyInterval("ANNUAL")).toBe(BILLING_INTERVAL.YEARLY);
    expect(intervalFromShopifyInterval("EVERY_30_DAYS")).toBe(BILLING_INTERVAL.MONTHLY);
  });

  it("returns null for anything it doesn't recognise, rather than guessing", () => {
    expect(intervalFromShopifyInterval("WEEKLY")).toBeNull();
    expect(intervalFromShopifyInterval(null)).toBeNull();
    expect(intervalFromShopifyInterval(undefined)).toBeNull();
  });
});
