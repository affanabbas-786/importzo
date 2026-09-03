import { describe, it, expect } from "vitest";
import {
  PLAN_IDS, PLANS, PLAN_ORDER, SHOPIFY_PLAN_NAME, AGENCY_MIN_STORES, AI_MONTHLY_CALL_CAP,
  isValidPlanId, getPlan, isUnlimited, scheduledSyncAllowed, isBillablePlanId, builtInAiAllowed,
  maxPartnersFor, isPartnerLinked, PARTNER_LINKED_STATUS,
} from "./plans.js";

describe("plans.js", () => {
  it("defines exactly the three plans in the product spec, with the specified prices", () => {
    expect(PLANS.free.price).toBe(0);
    expect(PLANS.pro.price).toBe(15);
    expect(PLANS.agency.price).toBe(35);
  });

  it("defines the specified record limits", () => {
    expect(PLANS.free.recordLimit).toBe(250);
    expect(PLANS.pro.recordLimit).toBe(Infinity);
    expect(PLANS.agency.recordLimit).toBe(Infinity);
  });

  it("only enables scheduled sync on Pro and Agency", () => {
    expect(scheduledSyncAllowed(PLAN_IDS.FREE)).toBe(false);
    expect(scheduledSyncAllowed(PLAN_IDS.PRO)).toBe(true);
    expect(scheduledSyncAllowed(PLAN_IDS.AGENCY)).toBe(true);
  });

  it("has no Shopify plan name for Free (never billed through Shopify)", () => {
    expect(PLANS.free.shopifyPlanName).toBeNull();
  });

  it("gives Pro and Agency distinct, stable Shopify plan names", () => {
    const names = [SHOPIFY_PLAN_NAME.pro, SHOPIFY_PLAN_NAME.agency];
    expect(new Set(names).size).toBe(2);
    for (const n of names) expect(n).toMatch(/^Importzo /);
  });

  it("marks only Agency as requiring eligibility", () => {
    expect(PLANS.free.requiresEligibility).toBeFalsy();
    expect(PLANS.pro.requiresEligibility).toBeFalsy();
    expect(PLANS.agency.requiresEligibility).toBe(true);
  });

  it("orders plans Free -> Pro -> Agency", () => {
    expect(PLAN_ORDER).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
  });

  it("isUnlimited reflects Infinity, not a large-number convention", () => {
    expect(isUnlimited(PLAN_IDS.FREE)).toBe(false);
    expect(isUnlimited(PLAN_IDS.PRO)).toBe(true);
    expect(isUnlimited(PLAN_IDS.AGENCY)).toBe(true);
  });

  it("isValidPlanId rejects unknown ids", () => {
    expect(isValidPlanId("free")).toBe(true);
    expect(isValidPlanId("enterprise")).toBe(false);
  });

  it("getPlan falls back to Free for an unknown id rather than throwing", () => {
    expect(getPlan("bogus")).toEqual(PLANS.free);
    expect(getPlan(undefined)).toEqual(PLANS.free);
  });

  it("isBillablePlanId excludes Free but includes the two paid tiers", () => {
    expect(isBillablePlanId(PLAN_IDS.FREE)).toBe(false);
    expect(isBillablePlanId(PLAN_IDS.PRO)).toBe(true);
    expect(isBillablePlanId(PLAN_IDS.AGENCY)).toBe(true);
    expect(isBillablePlanId("bogus")).toBe(false);
  });

  it("AGENCY_MIN_STORES matches the product spec (3+ stores)", () => {
    expect(AGENCY_MIN_STORES).toBe(3);
  });

  it("only enables built-in AI on Pro and Agency, same as scheduled sync", () => {
    expect(builtInAiAllowed(PLAN_IDS.FREE)).toBe(false);
    expect(builtInAiAllowed(PLAN_IDS.PRO)).toBe(true);
    expect(builtInAiAllowed(PLAN_IDS.AGENCY)).toBe(true);
  });

  it("AI_MONTHLY_CALL_CAP matches the product spec (500/month, shared)", () => {
    expect(AI_MONTHLY_CALL_CAP).toBe(500);
  });

  // Phase 12 — Partner/Agency linking, flat-priced.
  it("caps companion slots per the product spec: Free 0, Pro 1, Agency 5", () => {
    expect(maxPartnersFor(PLAN_IDS.FREE)).toBe(0);
    expect(maxPartnersFor(PLAN_IDS.PRO)).toBe(1);
    expect(maxPartnersFor(PLAN_IDS.AGENCY)).toBe(5);
  });

  it("prices Pro and Agency flat — no per-companion add-on helpers exist", async () => {
    // Flat: $15 covers payer + 1 companion, $35 covers payer + 5.
    expect(PLANS.pro.price).toBe(15);
    expect(PLANS.agency.price).toBe(35);
    const mod = await import("./plans.js");
    expect(mod.agencyPartnerPrice).toBeUndefined();
    expect(mod.agencyPartnerBillingPlanKey).toBeUndefined();
    expect(mod.AGENCY_PARTNER_ADDON).toBeUndefined();
  });

  it("maxPartnersFor falls back to 0 for an unknown tier rather than throwing", () => {
    expect(maxPartnersFor("bogus")).toBe(0);
  });

  it("isPartnerLinked recognises only the exact marker string", () => {
    expect(isPartnerLinked(PARTNER_LINKED_STATUS)).toBe(true);
    expect(isPartnerLinked("ACTIVE")).toBe(false);
    expect(isPartnerLinked("COMPLIMENTARY")).toBe(false);
    expect(isPartnerLinked(null)).toBe(false);
  });
});
