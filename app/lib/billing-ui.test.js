import { describe, it, expect, vi } from "vitest";
import { PLAN_IDS, PLANS, PLAN_ORDER } from "./plans.js";
import {
  quotaWarningFor,
  isQuotaError,
  REDIRECT_OVERLAY_COPY,
  planActionLabel,
  isUpgradeFrom,
  offersPlanSelection,
  planCta,
  freeCardLink,
  beginPlanSelection,
  shouldDismissOverlay,
  shouldDismissOverlayOnReshow,
  planConfirmationToast,
  featuredPlanId,
  isFeaturedPlan,
  planDisplayOrder,
  PLAN_DISPLAY_ORDER,
} from "./billing-ui.js";

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

  it("does not offer selection for the same tier AND same period", () => {
    expect(offersPlanSelection({
      planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.PRO,
      interval: "monthly", currentInterval: "monthly",
    })).toBe(false);
  });

  // The App Store review regression: a merchant on Pro monthly toggling to
  // yearly is a real, billable subscription change and MUST be offered — the
  // "Switch to yearly" button was rendering enabled but doing nothing because
  // this returned false for a "switch".
  it("offers selection for the same tier with a DIFFERENT billing period (interval switch)", () => {
    expect(offersPlanSelection({
      planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.PRO,
      interval: "yearly", currentInterval: "monthly",
    })).toBe(true);
    expect(offersPlanSelection({
      planId: PLAN_IDS.AGENCY, currentTier: PLAN_IDS.AGENCY,
      interval: "monthly", currentInterval: "yearly",
    })).toBe(true);
  });
});

describe("planCta trial-aware labelling", () => {
  it("labels a trial-eligible upgrade 'Start 7-day free trial', not 'Upgrade to X'", () => {
    const cta = planCta({ planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.FREE, trialEligible: true });
    expect(cta).toEqual({ kind: "select", label: "Start 7-day free trial", disabled: false });
  });

  it("keeps 'Upgrade to X' when the shop is no longer trial-eligible", () => {
    const cta = planCta({ planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.FREE, trialEligible: false });
    expect(cta).toEqual({ kind: "select", label: "Upgrade to Pro", disabled: false });
  });

  it("does not let trialEligible change a period switch or the current-plan state", () => {
    expect(planCta({
      planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.PRO,
      interval: "yearly", currentInterval: "monthly", trialEligible: true,
    })).toMatchObject({ kind: "switch", label: "Switch to yearly" });

    expect(planCta({
      planId: PLAN_IDS.PRO, currentTier: PLAN_IDS.PRO,
      interval: "monthly", currentInterval: "monthly", trialEligible: true,
    })).toMatchObject({ kind: "current", disabled: true });
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

  it("starts an interval switch on the plan the merchant already holds, submitting the new period", () => {
    const showOverlay = vi.fn();
    const submit = vi.fn();
    const result = beginPlanSelection({
      plan: PLANS.pro,
      interval: "yearly",
      currentTier: PLAN_IDS.PRO,
      currentInterval: "monthly",
      showOverlay,
      submit,
    });

    expect(result).toEqual({ started: true, reason: null });
    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ plan: PLAN_IDS.PRO, interval: "yearly" });
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

describe("shouldDismissOverlayOnReshow", () => {
  it("comes down on a bfcache restore — the merchant pressed Back from Shopify's plan page", () => {
    expect(shouldDismissOverlayOnReshow({
      persisted: true, visibilityState: "visible", wasHidden: false,
    })).toBe(true);
  });

  it("comes down when the page is shown again after having been hidden", () => {
    expect(shouldDismissOverlayOnReshow({
      persisted: false, visibilityState: "visible", wasHidden: true,
    })).toBe(true);
  });

  it("stays up on the outbound leg — visible, but never hidden yet", () => {
    expect(shouldDismissOverlayOnReshow({
      persisted: false, visibilityState: "visible", wasHidden: false,
    })).toBe(false);
  });

  it("stays up while the page is hidden — the redirect is in flight", () => {
    expect(shouldDismissOverlayOnReshow({
      persisted: false, visibilityState: "hidden", wasHidden: true,
    })).toBe(false);
  });
});

describe("planConfirmationToast", () => {
  it("says nothing when there is no plan_handle — this is not a return trip", () => {
    expect(planConfirmationToast({ planHandle: null, tier: PLAN_IDS.PRO, label: "Pro" })).toBeNull();
    expect(planConfirmationToast({ planHandle: "", tier: PLAN_IDS.FREE, label: "Free" })).toBeNull();
  });

  it("confirms the plan by name once the paid tier has actually reconciled", () => {
    expect(planConfirmationToast({ planHandle: "pro-monthly", tier: PLAN_IDS.PRO, label: "Pro" }))
      .toEqual({ message: "You're on the Pro plan" });
    expect(planConfirmationToast({ planHandle: "agency-yearly", tier: PLAN_IDS.AGENCY, label: "Agency" }))
      .toEqual({ message: "You're on the Agency plan" });
  });

  // The regression this function exists for: reconcile() lagging or failing
  // soft left the tier at Free, and the toast cheerfully told a merchant who
  // had just paid for Pro that they were on the Free plan.
  it("never claims Free to a merchant returning from a plan selection", () => {
    const toast = planConfirmationToast({ planHandle: "pro-monthly", tier: PLAN_IDS.FREE, label: "Free" });
    expect(toast.message).not.toMatch(/free/i);
    expect(toast.message).toMatch(/confirming/i);
  });

  it("does not dress the lag up as an error — the charge went through fine", () => {
    const toast = planConfirmationToast({ planHandle: "pro-monthly", tier: PLAN_IDS.FREE, label: "Free" });
    expect(toast.isError).toBeUndefined();
  });
});

describe("featuredPlanId", () => {
  // The "3+ connected stores -> feature Agency" model is gone. Pro is
  // featured, always — a multi-store merchant picks Agency off the card copy.
  it("always features Pro, taking no arguments", () => {
    expect(featuredPlanId()).toBe(PLAN_IDS.PRO);
  });

  it("never features Free", () => {
    expect(featuredPlanId()).not.toBe(PLAN_IDS.FREE);
  });
});

describe("isFeaturedPlan", () => {
  it("marks exactly one card — Pro", () => {
    const featured = PLAN_ORDER.filter((id) => isFeaturedPlan(id));
    expect(featured).toEqual([PLAN_IDS.PRO]);
  });

  it("is false for Free, Agency, and an unrecognised id", () => {
    expect(isFeaturedPlan(PLAN_IDS.FREE)).toBe(false);
    expect(isFeaturedPlan(PLAN_IDS.AGENCY)).toBe(false);
    expect(isFeaturedPlan("bogus")).toBe(false);
    expect(isFeaturedPlan(undefined)).toBe(false);
  });
});

describe("PLAN_DISPLAY_ORDER / planDisplayOrder", () => {
  it("is Free · Pro · Agency, with Pro (the featured plan) in the middle", () => {
    expect(planDisplayOrder()).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
    expect(planDisplayOrder()[1]).toBe(featuredPlanId());
    expect(planDisplayOrder()[0]).toBe(PLAN_IDS.FREE);
  });

  it("renders every plan exactly once", () => {
    const order = planDisplayOrder();
    expect(order).toHaveLength(PLAN_ORDER.length);
    expect([...order].sort()).toEqual([...PLAN_ORDER].sort());
  });

  // Display order and PLAN_ORDER (the pricing ladder isUpgradeFrom reads) are
  // kept separate on purpose — they happen to match today but must not alias.
  it("is a distinct constant from PLAN_ORDER", () => {
    expect(PLAN_ORDER).toEqual([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]);
    expect(PLAN_DISPLAY_ORDER).not.toBe(PLAN_ORDER);
  });

  it("is frozen, so a caller cannot reorder it in place", () => {
    expect(Object.isFrozen(PLAN_DISPLAY_ORDER)).toBe(true);
  });
});

describe("quotaWarningFor — pre-transfer plan check", () => {
  const free = { tier: "free", label: "Free", limit: 250, used: 0, remaining: 250, isUnlimited: false };

  it("says nothing on an unlimited plan", () => {
    expect(quotaWarningFor({ tier: "pro", label: "Pro", isUnlimited: true, limit: null })).toBeNull();
  });

  it("says nothing when usage is comfortably low", () => {
    expect(quotaWarningFor({ ...free, used: 10, remaining: 240 })).toBeNull();
  });

  it("blocks when the allowance is fully used", () => {
    const w = quotaWarningFor({ ...free, used: 250, remaining: 0 });
    expect(w.level).toBe("blocked");
    expect(w.title).toMatch(/used all 250 records/i);
  });

  it("warns once past the 80% mark", () => {
    const w = quotaWarningFor({ ...free, used: 200, remaining: 50 });
    expect(w.level).toBe("warning");
    expect(w.title).toMatch(/50 of 250 records left/i);
  });

  // The case the merchant most needs told in advance: plenty of allowance
  // left in absolute terms, but this particular transfer is bigger than it.
  it("warns when the estimated transfer exceeds what remains", () => {
    const w = quotaWarningFor({ ...free, used: 0, remaining: 250 }, 5061);
    expect(w.level).toBe("warning");
    expect(w.message).toMatch(/5,061 records are expected but only 250 remain/i);
  });

  it("does not warn when the estimate fits", () => {
    expect(quotaWarningFor({ ...free, used: 0, remaining: 250 }, 100)).toBeNull();
  });

  it("ignores a non-numeric estimate rather than warning spuriously", () => {
    expect(quotaWarningFor({ ...free, used: 0, remaining: 250 }, null)).toBeNull();
    expect(quotaWarningFor({ ...free, used: 0, remaining: 250 }, "lots")).toBeNull();
  });

  it("tolerates a missing usage object", () => {
    expect(quotaWarningFor(null)).toBeNull();
    expect(quotaWarningFor(undefined)).toBeNull();
  });
});

describe("isQuotaError — telling a plan limit apart from a real failure", () => {
  it("matches the transfer engine's own skip message", () => {
    expect(isQuotaError("Skipped — plan limit reached (upgrade to continue)")).toBe(true);
  });

  it("matches assertQuotaAvailable's message", () => {
    expect(isQuotaError("You've used all 250 records included in your Free plan this month. Upgrade to Pro for unlimited records — $15/month or $144/year — or wait for your usage to reset.")).toBe(true);
  });

  // The whole point of the distinction: a throttle is retryable and is NOT a
  // billing problem, so it must not show an upgrade prompt.
  it("does not match a rate-limit failure", () => {
    expect(isQuotaError("Shopify rate limit (THROTTLED) — still refused after 3 retries. This item can be retried.")).toBe(false);
    expect(isQuotaError("GraphQL HTTP 429")).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(isQuotaError("Gift card products cannot be transferred")).toBe(false);
    expect(isQuotaError("")).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});
