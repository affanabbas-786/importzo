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

import { PLAN_IDS, PLAN_ORDER } from "./plans.js";

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
 *   3+ connected stores  -> Agency. Identical features to Pro at $10/store
 *                           instead of $15, so for this merchant it is
 *                           strictly the better deal and recommending
 *                           anything else would be costing them money.
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
 * (Agency is the cheaper per-store rate), so it says "Switch to" instead of
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
 */
export function offersPlanSelection({ planId, currentTier }) {
  if (planId === PLAN_IDS.FREE) return false;
  return planId !== currentTier;
}

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
  return { label: "Downgrade in Shopify", description: "Cancel your paid plan on Shopify's plan page." };
}

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
export function beginPlanSelection({ plan, currentTier, showOverlay, submit }) {
  if (!offersPlanSelection({ planId: plan?.id, currentTier })) {
    return { started: false, reason: plan?.id === PLAN_IDS.FREE ? "free-plan" : "already-on-plan" };
  }

  showOverlay();
  submit();
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
