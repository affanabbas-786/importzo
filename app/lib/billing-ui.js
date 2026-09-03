// ═══════════════════════════════════════════════════════════════════
// Phase 9 — Billing page interaction logic, extracted from the route.
//
// Pure functions and copy only (no React, no Prisma, no Shopify client),
// for the same reason plans.js is: this is imported by a client-rendered
// route component, and keeping the decisions out of the component is what
// makes the ORDERING testable — see billing-ui.test.js.
//
// Why this exists at all: under Shopify App Pricing the merchant leaves the
// app entirely to approve a charge. That handoff is a full top-level browser
// navigation to admin.shopify.com and it is not instant — several seconds is
// normal. Between the click and Shopify's page painting, the merchant is
// looking at an app that appears to have done nothing. Everything below is
// in service of that gap.
// ═══════════════════════════════════════════════════════════════════

import { PLAN_IDS, PLANS, PLAN_ORDER, BILLING_INTERVAL, TRIAL_DAYS, isBillablePlanId } from "./plans.js";

/**
 * Copy for the overlay shown while the browser is on its way to Shopify.
 *
 * Split into three parts rather than one blob because each answers a
 * different question the merchant has in that moment: what is happening,
 * why nothing has visibly changed yet, and — the one that actually matters —
 * whether clicking a button just charged them. It has not: under App Pricing
 * the charge is created by Shopify only after the merchant approves it on
 * Shopify's own page, so the reassurance below is a statement of fact about
 * the flow, not a comfort blanket.
 */
export const REDIRECT_OVERLAY_COPY = Object.freeze({
  title: "Redirecting to Shopify for approval…",
  timing: "This can take a few seconds.",
  reassurance:
    "You'll land on Shopify's approval page — no charge is created until you approve it there.",
});

/**
 * Which plan gets the featured treatment, for THIS shop.
 *
 * A function of eligibility rather than a constant, and that is the whole
 * point: this page knows something the public marketing site cannot. The
 * landing page has no idea who is reading it, so it features Pro for
 * everyone. Here we have the shop's real connected-store count, so each
 * merchant can be pointed at the plan that is genuinely best for them.
 *
 *   3+ connected stores  -> Agency. Identical features to Pro, one flat
 *                           price covering the payer + up to 5 companion
 *                           stores, so for a multi-store merchant it is the
 *                           better deal and recommending anything else would
 *                           be costing them money.
 *   fewer than that      -> Pro. Agency is not usable by them in practice;
 *                           featuring a card that carries its own "unlocks at
 *                           3+ stores" warning is pointing a merchant at
 *                           something they cannot have.
 *
 * Deliberately NOT a function of the merchant's current tier. The featured
 * card marks the best-fit plan, not the one they are already on — that is what
 * the "Current plan" pill says, and one card can legitimately carry both.
 */
export function featuredPlanId(eligibility) {
  return eligibility?.eligible ? PLAN_IDS.AGENCY : PLAN_IDS.PRO;
}

/**
 * Whether a given card gets the featured chrome — border, lift, badge.
 *
 * Note this changes the CHROME only. The amber "unlocks at 3+ stores" notice
 * inside the Agency card is driven separately, off plan.requiresEligibility,
 * so an ineligible merchant still sees that warning on an unfeatured card.
 */
export function isFeaturedPlan(planId, eligibility) {
  return planId === featuredPlanId(eligibility);
}

/**
 * Left-to-right order the plan cards are RENDERED in, keyed by which plan is
 * currently featured.
 *
 * Deliberately not PLAN_ORDER. That array is the price/rank ladder — Free is
 * below Pro is below Agency — and isUpgradeFrom() reads positions out of it to
 * decide whether a move is an upgrade or a switch. Reordering it to suit the
 * layout would silently relabel "Upgrade to Agency" as "Switch to Agency".
 * They are different orderings of the same three ids and they are kept apart
 * on purpose — note that the Pro-featured row below happens to match
 * PLAN_ORDER today, and is still spelled out rather than aliased to it, so a
 * future change to the ranking cannot quietly reshuffle the layout.
 *
 * The single rule: the featured plan sits in the middle. A highlighted plan at
 * the end of a row reads as an afterthought; in the middle it reads as the
 * recommendation. Free stays leftmost either way so the row still opens at $0.
 */
export const PLAN_DISPLAY_ORDER = Object.freeze({
  [PLAN_IDS.AGENCY]: Object.freeze([PLAN_IDS.FREE, PLAN_IDS.AGENCY, PLAN_IDS.PRO]),
  [PLAN_IDS.PRO]: Object.freeze([PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]),
});

/** The render order for this shop, with its featured plan in the middle. */
export function planDisplayOrder(eligibility) {
  return PLAN_DISPLAY_ORDER[featuredPlanId(eligibility)];
}

/**
 * Label for a plan card's call to action.
 *
 * "Upgrade to Pro" rather than "Choose Pro in Shopify": the merchant is
 * upgrading, and the fact that the last step happens on Shopify's page is
 * explained by the overlay and the section blurb, not crammed into a button.
 *
 * Moving from Agency to Pro is the one direction that is not an upgrade
 * (Agency sits above Pro in PLAN_ORDER), so it says "Switch to" instead of
 * telling a merchant they are upgrading to something they are not.
 */
export function planActionLabel(plan, currentTier) {
  const verb = isUpgradeFrom(currentTier, plan?.id) ? "Upgrade" : "Switch";
  return `${verb} to ${plan?.label}`;
}

/** True when `toId` sits above `fromId` in PLAN_ORDER (free → pro → agency). */
export function isUpgradeFrom(fromId, toId) {
  const from = PLAN_ORDER.indexOf(fromId);
  const to = PLAN_ORDER.indexOf(toId);
  if (from === -1 || to === -1) return false;
  return to > from;
}

/**
 * Whether a plan card gets the plan-selection button at all.
 *
 * Free never does, and this is the load-bearing half of that rule. Free is
 * not a Shopify plan — there is no $0 AppSubscription to create and nothing
 * for a merchant to approve — so sending someone to the hosted approval page
 * to "select" it would show them Shopify's paid-plan UI for a transaction
 * that does not exist. A merchant already on Free would be redirected to
 * approve the plan they are already on; a merchant downgrading to Free needs
 * to CANCEL a subscription, which is a different action on a different part
 * of Shopify's page. Neither is the paid upgrade flow, so neither gets the
 * paid upgrade button. See freeCardLink for what they get instead.
 *
 * BOTH "select" (a genuine tier change) and "switch" (same tier, other
 * billing period) are real, billable AppSubscription changes that go through
 * the same approval flow — so both count. The bug this line once had:
 * checking only for "select" meant a merchant on Pro monthly who toggled to
 * yearly got an enabled "Switch to yearly" button whose click did nothing,
 * because beginPlanSelection asked this function first and it said no. (App
 * Store review rejection, "monthly/yearly toggle unresponsive on an active
 * subscription".)
 */
export function offersPlanSelection({ planId, currentTier, interval, currentInterval }) {
  if (planId === PLAN_IDS.FREE) return false;
  const kind = planCta({ planId, currentTier, interval, currentInterval }).kind;
  return kind === "select" || kind === "switch";
}

/**
 * What a plan card's single call-to-action should be, in this period.
 *
 * One function instead of a scatter of booleans in the component, because the
 * states are mutually exclusive and getting the precedence wrong is exactly
 * the bug this replaced: a shop on Pro was shown "Upgrade to Pro". That
 * happened because the card compared tier AND interval, and `interval` was
 * null — Shopify does not always return line items, and reconcile() honestly
 * reports null rather than guessing. `monthly !== null` read as "different
 * plan", so the card offered a merchant the plan they were already paying for.
 *
 * The fix is the `currentInterval == null` branch below: when the tier matches
 * but the period is UNKNOWN, the honest answer is "you're on this plan", not
 * "upgrade". An unknown period is not a different period.
 *
 * Kinds:
 *   current   — this exact plan and period. Disabled.
 *   switch    — same tier, other period. A real billable change.
 *   downgrade — the Free card, for a shop on a paid plan.
 *   included  — the Free card, for a shop already on Free. Disabled.
 *   select    — anything else: a genuine upgrade or tier change.
 *
 * `trialEligible` only changes the "select" label — from "Upgrade to X" to
 * "Start free trial" — since that is the one action that actually begins a
 * trial. A period switch on a plan the merchant already holds is past the
 * trial, so it keeps "Switch to …".
 */
export function planCta({ planId, currentTier, interval, currentInterval, trialEligible = false }) {
  if (planId === PLAN_IDS.FREE) {
    return currentTier === PLAN_IDS.FREE
      ? { kind: "included", label: "Included", disabled: true }
      : { kind: "downgrade", label: "Downgrade to Free", disabled: false };
  }

  if (planId === currentTier) {
    // Unknown period counts as "the one you're on" — see above.
    if (currentInterval == null || interval === currentInterval) {
      return { kind: "current", label: "Active plan", disabled: true };
    }
    return {
      kind: "switch",
      label: interval === BILLING_INTERVAL.YEARLY ? "Switch to yearly" : "Switch to monthly",
      disabled: false,
    };
  }

  return {
    kind: "select",
    label: trialEligible ? `Start ${TRIAL_DAYS}-day free trial` : `Upgrade to ${PLANS[planId]?.label || planId}`,
    disabled: false,
  };
}

/**
 * The feature bullets a plan card lists.
 *
 * Derived from the plan's own capability flags rather than written out per
 * plan, so a card can never advertise something plans.js does not actually
 * grant — the failure mode of a hand-maintained second list.
 */
export function planFeatures(plan) {
  if (!plan) return [];
  const records = plan.recordLimit === Infinity
    ? "Unlimited records per month"
    : `${plan.recordLimit.toLocaleString()} records per month`;

  return [
    records,
    plan.scheduledSync ? "Scheduled automatic sync" : "Manual imports",
    plan.builtInAi ? "Built-in AI mapping & enhancement" : "Bring your own AI key",
    plan.requiresEligibility ? "Priority support for agencies" : plan.price > 0 ? "Priority email support" : "Email support",
  ];
}

/** Copy for the billing-period toggle above the cards. */
export const PERIOD_TOGGLE_OPTIONS = Object.freeze([
  { key: BILLING_INTERVAL.MONTHLY, label: "Pay monthly" },
  { key: BILLING_INTERVAL.YEARLY, label: "Pay yearly" },
]);

/** Everything each plan includes, listed once below the cards. */
export const ALL_PLANS_INCLUDE = Object.freeze([
  "Free to install",
  "Cancel anytime",
  "Email support",
  "Automatic updates",
  "GDPR compliant",
]);

/**
 * What the Free card shows instead of an upgrade button.
 *
 * Already on Free: nothing — the "Current plan" badge has said it.
 * On a paid plan: a plain link to Shopify's plan page, because cancelling is
 * done there. Deliberately a link and not the plan-selection button — no
 * overlay, no POST, no "no charge is created until you approve" copy, none
 * of which is true of a downgrade. Without it the card is a dead end for the
 * one merchant who has any reason to act on it.
 */
export function freeCardLink({ currentTier }) {
  if (currentTier === PLAN_IDS.FREE) return null;
  // Phase 10 — a real in-app action, not a link off to Shopify.
  //
  // Free has no charge to create, so there is nothing for a merchant to
  // approve and nowhere they need to be sent: cancelling the live
  // subscription is a single API call this app is allowed to make. The whole
  // downgrade now happens without leaving the page.
  //
  // The description states the two things Shopify decides and this app does
  // not — that the change lands at the end of the cycle, and that the unused
  // remainder is credited — because a merchant pressing "cancel" reasonably
  // expects it to be immediate, and finding out otherwise from a bill is
  // worse than reading it here.
  return {
    label: "Downgrade to Free",
    description: "Cancels your paid plan at the end of the current billing cycle. Unused time is credited.",
  };
}

/**
 * Copy for the confirmation step before a cancellation is actually sent.
 *
 * Cancelling is the one action on this page that removes something the
 * merchant is paying for, and unlike every other button it is NOT followed by
 * a Shopify approval screen that would give them a second look at it. That
 * missing step is the reason this exists: without it, one stray click ends a
 * subscription outright.
 */
export const CANCEL_CONFIRM_COPY = Object.freeze({
  title: "Downgrade to Free?",
  body:
    "Your paid plan stays active until the end of the current billing cycle, and Shopify credits the unused portion. "
    + "After that, Importzo returns to the Free limits.",
  confirm: "Yes, downgrade to Free",
  dismiss: "Keep my plan",
});

/**
 * The plan button's click handler, as a function of its effects.
 *
 * `showOverlay` is called BEFORE `submit`, and that order is the point:
 * `submit` starts a POST whose success case is a 401 carrying a
 * reauthorize-URL header, which App Bridge turns into a top-level
 * navigation. From the click onward the merchant should be looking at the
 * overlay — not at an unchanged page, and not at a flicker.
 *
 * Returns why it declined rather than failing silently, so a caller (and a
 * test) can tell "Free plan, correctly refused" apart from "nothing
 * happened".
 */
export function beginPlanSelection({ plan, interval, currentTier, currentInterval, showOverlay, submit }) {
  if (!offersPlanSelection({ planId: plan?.id, currentTier, interval, currentInterval })) {
    return { started: false, reason: plan?.id === PLAN_IDS.FREE ? "free-plan" : "already-on-plan" };
  }

  showOverlay();
  // The interval is passed to the caller's submit rather than assumed, so the
  // charge Shopify creates is the one whose price the merchant just read off
  // this card. See the action in app.billing.jsx, which resolves the pair into
  // a billing key and refuses anything it cannot resolve.
  submit({ plan: plan.id, interval });
  return { started: true, reason: null };
}

/**
 * Whether to take the overlay back down.
 *
 * Only on a failed action. On success the overlay must STAY up: the fetcher
 * settles back to idle the moment App Bridge picks up the redirect, but the
 * browser is still seconds away from Shopify's page. Tying the overlay to
 * `fetcher.state` alone would drop it exactly then and hand the merchant
 * back a page that looks like their click did nothing — the flicker this
 * whole mechanism exists to prevent.
 */
export function shouldDismissOverlay({ state, data }) {
  return state === "idle" && data?.ok === false;
}

/**
 * The other half of taking the overlay down: the merchant is looking at this
 * page again.
 *
 * shouldDismissOverlay above only fires on a failed action, which is correct
 * for the outbound leg but leaves two return paths where the overlay stays up
 * over a navigation that is never going to happen:
 *
 *   1. The merchant reaches Shopify's plan page, decides against it, and
 *      presses Back. The top-level navigation is restored from bfcache with
 *      this component's React state intact — overlayOpen still true.
 *   2. The App Bridge handoff silently does not occur (the 401 + reauthorize
 *      header not picked up). The fetcher settles to idle with ok !== false,
 *      so nothing clears it.
 *
 * Both matter more than an ordinary stuck spinner because RedirectingOverlay
 * is an alertdialog with no dismiss control by design — the merchant's only
 * way out is to reload the page. Both end in the same observable state, so
 * that is what this keys on rather than trying to distinguish them.
 *
 * `wasHidden` is what keeps this from firing on the outbound leg. Becoming
 * visible is only meaningful as a RETURN if the page was hidden first; without
 * it, a merchant tabbing away and back while the redirect is still in flight
 * would lose the overlay early. `persisted` (a bfcache restore) needs no such
 * qualification — it can only mean case 1.
 */
export function shouldDismissOverlayOnReshow({ persisted, visibilityState, wasHidden }) {
  if (persisted) return true;
  return Boolean(wasHidden) && visibilityState === "visible";
}

/**
 * The toast shown when Shopify sends the merchant back after they pick a plan.
 *
 * Shopify appends ?plan_handle=... to the welcome link, so its presence means
 * the round trip landed — but it says nothing about whether THIS app has
 * caught up yet. The tier is reconciled from billing.check() in the loader,
 * and that can legitimately not yet reflect the new subscription: activation
 * can lag the redirect, and reconcile() is explicitly allowed to fail soft
 * (falling back to the stale local ShopPlan) rather than break the page.
 *
 * In either case the old unconditional `You're on the ${label} plan` announced
 * the STALE tier — telling a merchant who had just paid for Pro that they are
 * on the Free plan, at the exact moment they are most alert to being charged
 * correctly. So the confident message is only used when the reconciled tier is
 * actually a paid one; otherwise the merchant is told the truth, which is that
 * it is still settling.
 *
 * Neither case is an error toast. Nothing has gone wrong in either — one is
 * success, the other is a few seconds of lag — and colouring the second one
 * red would manufacture alarm about a charge that went through fine.
 */
export function planConfirmationToast({ planHandle, tier, label }) {
  if (!planHandle) return null;

  if (isBillablePlanId(tier)) {
    return { message: `You're on the ${label} plan` };
  }

  return { message: "Confirming your plan with Shopify — reload in a moment if it hasn't updated." };
}

// ═══════════════════════════════════════════════════════════════════
// Pre-transfer quota warning.
//
// The Transfer flow can consume hundreds of records in one run, and until
// now the only place a merchant could see their remaining allowance was
// /app/billing. A transfer that hit the cap mid-run just started emitting
// per-item errors, with nothing on screen connecting them to the plan
// limit. This decides what to tell them BEFORE they press the button.
// ═══════════════════════════════════════════════════════════════════

// Fraction of the monthly allowance that counts as "nearly out".
export const QUOTA_WARN_AT = 0.8;

/**
 * Pre-flight quota assessment for a transfer.
 *
 * `usage` is the shape app.transfer.jsx's loader returns (a subset of
 * getUsageStatus). `estimatedRecords`, when known, is how many records the
 * selected modules are expected to write — an estimate that exceeds what's
 * left is worth warning about even when plenty of headroom remains today.
 *
 * Returns null when there is nothing worth saying, or
 * { level, title, message } where level is "blocked" | "warning".
 * Unlimited plans always return null.
 */
export function quotaWarningFor(usage, estimatedRecords = null) {
  if (!usage || usage.isUnlimited) return null;

  const limit = Number(usage.limit) || 0;
  const remaining = Math.max(Number(usage.remaining) || 0, 0);
  if (limit <= 0) return null;

  if (remaining === 0) {
    return {
      level: "blocked",
      title: `You've used all ${limit.toLocaleString()} records in your ${usage.label} plan this month`,
      message: "This transfer can't write anything until your usage resets or you upgrade.",
    };
  }

  const estimate = Number(estimatedRecords);
  if (Number.isFinite(estimate) && estimate > remaining) {
    return {
      level: "warning",
      title: `This transfer is larger than your remaining allowance`,
      message: `About ${estimate.toLocaleString()} records are expected but only ${remaining.toLocaleString()} remain on your ${usage.label} plan this month. The transfer will stop partway once the limit is reached.`,
    };
  }

  if (usage.used / limit >= QUOTA_WARN_AT) {
    return {
      level: "warning",
      title: `${remaining.toLocaleString()} of ${limit.toLocaleString()} records left this month`,
      message: `You're close to your ${usage.label} plan limit. A large transfer may stop partway once it's reached.`,
    };
  }

  return null;
}

// Matches the quota-exhaustion errors the transfer engine emits (see
// assertQuotaAvailable in usage.server.js and the "plan limit reached"
// skip rows in app.transfer.jsx) so the results screen can show an
// upgrade link instead of a generic failure message.
const QUOTA_ERROR_PATTERN = /plan limit reached|used all \d[\d,]* records|Upgrade to Pro for unlimited/i;

/** True when this item failed because the shop ran out of plan allowance. */
export function isQuotaError(message) {
  return QUOTA_ERROR_PATTERN.test(String(message || ""));
}
