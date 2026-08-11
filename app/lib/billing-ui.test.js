import { describe, it, expect, vi } from "vitest";
import { PLAN_IDS, PLANS, PLAN_ORDER } from "./plans.js";
import {
  REDIRECT_OVERLAY_COPY,
  planActionLabel,
  isUpgradeFrom,
  offersPlanSelection,
  freeCardLink,
  beginPlanSelection,
  shouldDismissOverlay,
  featuredPlanId,
  isFeaturedPlan,
  planDisplayOrder,
  PLAN_DISPLAY_ORDER,
} from "./billing-ui.js";

// The two shapes checkAgencyEligibility returns, as the billing loader passes
// them straight through to these helpers.
const ELIGIBLE = { eligible: true, storeCount: 3, minStores: 3 };
const INELIGIBLE = { eligible: false, storeCount: 1, minStores: 3 };

describe("REDIRECT_OVERLAY_COPY", () => {
  it("names Shopify's approval page and states plainly that no charge is created yet", () => {
    expect(REDIRECT_OVERLAY_COPY.title).toMatch(/redirecting/i);
    expect(REDIRECT_OVERLAY_COPY.title).toMatch(/shopify/i);
    expect(REDIRECT_OVERLAY_COPY.reassurance).toMatch(/no charge/i);
    expect(REDIRECT_OVERLAY_COPY.reassurance).toMatch(/approve/i);
  });
});

describe("isUpgradeFrom", () => {
  it("is true moving up PLAN_ORDER (free -> pro, free -> agency, pro -> agency)", () => {
    expect(isUpgradeFrom(PLAN_IDS.FREE, PLAN_IDS.PRO)).toBe(true);
    expect(isUpgradeFrom(PLAN_IDS.FREE, PLAN_IDS.AGENCY)).toBe(true);
    expect(isUpgradeFrom(PLAN_IDS.PRO, PLAN_IDS.AGENCY)).toBe(true);
  });

  it("is false moving down or sideways, including Agency -> Pro", () => {
    expect(isUpgradeFrom(PLAN_IDS.AGENCY, PLAN_IDS.PRO)).toBe(false);
    expect(isUpgradeFrom(PLAN_IDS.PRO, PLAN_IDS.FREE)).toBe(false);
    expect(isUpgradeFrom(PLAN_IDS.PRO, PLAN_IDS.PRO)).toBe(false);
  });

  it("is false for an unrecognised tier rather than throwing", () => {
    expect(isUpgradeFrom("bogus", PLAN_IDS.PRO)).toBe(false);
    expect(isUpgradeFrom(PLAN_IDS.FREE, "bogus")).toBe(false);
  });
});

describe("planActionLabel", () => {
  it("reads as a continuation of leaving the app, not an in-app action", () => {
    expect(planActionLabel(PLANS.pro, PLAN_IDS.FREE)).toBe("Upgrade to Pro");
    expect(planActionLabel(PLANS.agency, PLAN_IDS.FREE)).toBe("Upgrade to Agency");
    expect(planActionLabel(PLANS.agency, PLAN_IDS.PRO)).toBe("Upgrade to Agency");
  });

  it("says Switch, not Upgrade, for Agency -> Pro (the one direction that is cheaper, not an upgrade)", () => {
    expect(planActionLabel(PLANS.pro, PLAN_IDS.AGENCY)).toBe("Switch to Pro");
  });

  it("never says 'in Shopify' or 'Choose' — the old copy this replaces", () => {
    const label = planActionLabel(PLANS.pro, PLAN_IDS.FREE);
    expect(label).not.toMatch(/in shopify/i);
    expect(label).not.toMatch(/^choose/i);
  });
});

describe("offersPlanSelection", () => {
  it("never offers plan selection for Free, on any current tier", () => {
    expect(offersPlanSelection({ planId: PLAN_IDS.FREE, currentTier: PLAN_IDS.FREE })).toBe(false);
    expect(offersPlanSelection({ planId: PLAN_IDS.FREE, currentTier: PLAN_IDS.PRO })).toBe(false);
    expect(offersPlanSelection({ planId: PLAN_IDS.FREE, currentTier: PLAN_IDS.AGENCY })).toBe(false);
  });

  it("offers selection for a paid plan the merchant is not already on", () => {
    expect(offersPlanSelection({ planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.FREE })).toBe(true);
    expect(offersPlanSelection({ planId: PLAN_IDS.AGENCY, currentTier: PLAN_IDS.PRO })).toBe(true);
  });

  it("does not offer selection for the plan the merchant is already on", () => {
    expect(offersPlanSelection({ planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.PRO })).toBe(false);
  });
});

describe("freeCardLink", () => {
  it("is null when the merchant is already on Free — the Current plan badge already says it", () => {
    expect(freeCardLink({ currentTier: PLAN_IDS.FREE })).toBeNull();
  });

  it("offers a downgrade link (not the paid-upgrade button) for a merchant on a paid plan", () => {
    const link = freeCardLink({ currentTier: PLAN_IDS.PRO });
    expect(link).toEqual(
      expect.objectContaining({
        label: expect.stringMatching(/downgrade/i),
        description: expect.stringMatching(/cancel/i),
      }),
    );
  });
});

describe("beginPlanSelection", () => {
  it("declines a Free-plan selection without calling showOverlay or submit", () => {
    const showOverlay = vi.fn();
    const submit = vi.fn();
    const result = beginPlanSelection({
      plan: PLANS.free,
      currentTier: PLAN_IDS.PRO,
      showOverlay,
      submit,
    });

    expect(result).toEqual({ started: false, reason: "free-plan" });
    expect(showOverlay).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("declines re-selecting the plan the merchant is already on", () => {
    const showOverlay = vi.fn();
    const submit = vi.fn();
    const result = beginPlanSelection({
      plan: PLANS.pro,
      currentTier: PLAN_IDS.PRO,
      showOverlay,
      submit,
    });

    expect(result).toEqual({ started: false, reason: "already-on-plan" });
    expect(showOverlay).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows the overlay BEFORE submitting for a real paid-plan selection", () => {
    const order = [];
    const showOverlay = vi.fn(() => order.push("showOverlay"));
    const submit = vi.fn(() => order.push("submit"));

    const result = beginPlanSelection({
      plan: PLANS.pro,
      currentTier: PLAN_IDS.FREE,
      showOverlay,
      submit,
    });

    expect(result).toEqual({ started: true, reason: null });
    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    // The overlay must be up before the POST that triggers the top-level
    // redirect is ever sent — not merely called once each, but in this order.
    expect(order).toEqual(["showOverlay", "submit"]);
  });

  it("still calls showOverlay before submit even if submit throws synchronously", () => {
    const order = [];
    const showOverlay = vi.fn(() => order.push("showOverlay"));
    const submit = vi.fn(() => {
      order.push("submit");
      throw new Error("boom");
    });

    expect(() =>
      beginPlanSelection({ plan: PLANS.agency, currentTier: PLAN_IDS.FREE, showOverlay, submit }),
    ).toThrow("boom");
    expect(order).toEqual(["showOverlay", "submit"]);
  });
});

describe("shouldDismissOverlay", () => {
  it("stays up while the fetcher is still submitting or loading", () => {
    expect(shouldDismissOverlay({ state: "submitting", data: undefined })).toBe(false);
    expect(shouldDismissOverlay({ state: "loading", data: undefined })).toBe(false);
  });

  it("stays up when the fetcher settles back to idle with no error — the redirect is still in flight", () => {
    expect(shouldDismissOverlay({ state: "idle", data: undefined })).toBe(false);
    expect(shouldDismissOverlay({ state: "idle", data: { ok: true } })).toBe(false);
  });

  it("comes down only once idle AND the action reported failure", () => {
    expect(shouldDismissOverlay({ state: "idle", data: { ok: false, error: "nope" } })).toBe(true);
  });

  it("does not dismiss on failure while still submitting", () => {
    expect(shouldDismissOverlay({ state: "submitting", data: { ok: false } })).toBe(false);
  });
});

describe("featuredPlanId", () => {
  it("features Agency once the shop actually has the 3+ stores it needs", () => {
    expect(featuredPlanId(ELIGIBLE)).toBe(PLAN_IDS.AGENCY);
  });

  // The point of making this conditional: Agency's own card carries an
  // "unlocks at 3+ stores" warning, so highlighting it for a one-store
  // merchant recommends a plan they cannot use.
  it("features Pro for a shop that does not qualify for Agency", () => {
    expect(featuredPlanId(INELIGIBLE)).toBe(PLAN_IDS.PRO);
  });

  it("never features Free", () => {
    expect(featuredPlanId(ELIGIBLE)).not.toBe(PLAN_IDS.FREE);
    expect(featuredPlanId(INELIGIBLE)).not.toBe(PLAN_IDS.FREE);
  });

  // The loader builds eligibility from a live Shopify call that is allowed to
  // fail soft, so this must not throw the whole billing page.
  it("falls back to Pro when eligibility is missing or malformed", () => {
    expect(featuredPlanId(undefined)).toBe(PLAN_IDS.PRO);
    expect(featuredPlanId(null)).toBe(PLAN_IDS.PRO);
    expect(featuredPlanId({})).toBe(PLAN_IDS.PRO);
  });
});

describe("isFeaturedPlan", () => {
  it("marks exactly one card per shop — Agency when eligible", () => {
    const featured = PLAN_ORDER.filter((id) => isFeaturedPlan(id, ELIGIBLE));
    expect(featured).toEqual([PLAN_IDS.AGENCY]);
  });

  it("marks exactly one card per shop — Pro when ineligible", () => {
    const featured = PLAN_ORDER.filter((id) => isFeaturedPlan(id, INELIGIBLE));
    expect(featured).toEqual([PLAN_IDS.PRO]);
  });

  it("does not feature Agency for an ineligible shop", () => {
    expect(isFeaturedPlan(PLAN_IDS.AGENCY, INELIGIBLE)).toBe(false);
    expect(isFeaturedPlan(PLAN_IDS.PRO, INELIGIBLE)).toBe(true);
  });

  it("ignores the merchant's current tier — the badge marks best fit, not status", () => {
    // Same eligibility, so the same card is featured no matter what they're on.
    for (const tier of [PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]) {
      expect(isFeaturedPlan(PLAN_IDS.AGENCY, { ...ELIGIBLE, tier })).toBe(true);
    }
  });

  it("is false for an unrecognised plan id rather than throwing", () => {
    expect(isFeaturedPlan("bogus", ELIGIBLE)).toBe(false);
    expect(isFeaturedPlan(undefined, ELIGIBLE)).toBe(false);
  });
});

describe("PLAN_DISPLAY_ORDER / planDisplayOrder", () => {
  it("puts Agency in the middle when it is the featured plan", () => {
    expect(planDisplayOrder(ELIGIBLE)).toEqual([PLAN_IDS.FREE, PLAN_IDS.AGENCY, PLAN_IDS.PRO]);
  });

  it("puts Pro in the middle when it is the featured plan", () => {
    expect(planDisplayOrder(INELIGIBLE)).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
  });

  // The rule the layout rests on, asserted directly rather than via the two
  // literal arrays above: whichever plan is featured is the one in slot 1.
  it("always places the featured plan in the middle slot", () => {
    for (const eligibility of [ELIGIBLE, INELIGIBLE]) {
      const order = planDisplayOrder(eligibility);
      expect(order[1]).toBe(featuredPlanId(eligibility));
    }
  });

  it("always opens the row at $0 with Free leftmost", () => {
    for (const eligibility of [ELIGIBLE, INELIGIBLE]) {
      expect(planDisplayOrder(eligibility)[0]).toBe(PLAN_IDS.FREE);
    }
  });

  it("renders every plan exactly once, whichever order is used", () => {
    for (const eligibility of [ELIGIBLE, INELIGIBLE]) {
      const order = planDisplayOrder(eligibility);
      expect(order).toHaveLength(PLAN_ORDER.length);
      expect([...order].sort()).toEqual([...PLAN_ORDER].sort());
    }
  });

  // These are two different orderings of the same ids and isUpgradeFrom()
  // reads positions out of PLAN_ORDER; a display change must never reach it.
  it("leaves PLAN_ORDER, the pricing ladder, untouched", () => {
    expect(PLAN_ORDER).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
    expect(planDisplayOrder(ELIGIBLE)).not.toEqual(PLAN_ORDER);
  });

  it("is frozen, so a caller cannot reorder the shared arrays in place", () => {
    expect(Object.isFrozen(PLAN_DISPLAY_ORDER)).toBe(true);
    expect(Object.isFrozen(PLAN_DISPLAY_ORDER[PLAN_IDS.AGENCY])).toBe(true);
    expect(Object.isFrozen(PLAN_DISPLAY_ORDER[PLAN_IDS.PRO])).toBe(true);
  });

  it("falls back to a usable order when eligibility is missing", () => {
    expect(planDisplayOrder(undefined)).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
  });
});
