import PropTypes from "prop-types";
import { PLAN_IDS, AGENCY_MIN_STORES, BILLING_INTERVAL, TRIAL_DAYS, yearlySavingsPercent } from "../lib/plans.js";
import { planCta, planFeatures } from "../lib/billing-ui.js";
import { BRAND } from "../lib/constants";

const { primary: P, secondary: S, font: F } = BRAND;

/**
 * Phase 10 — rebuilt to match the Citeable app's Plans card, which is the
 * design this page was asked to reproduce, with its purple accent remapped to
 * Importzo green. The chrome that makes the featured card read as featured —
 * ring, lift, top bar, glint — lives in tailwind.css under .iz-plan-cell.
 *
 * ONE call-to-action per card, not one per interval. The interval is chosen
 * once by the toggle above the grid, so a card shows a single price and a
 * single button that charges it. Two buttons per card made the merchant read
 * four prices at once to compare three plans.
 *
 * Presentational only: which CTA a card gets, and what it says, comes from
 * planCta() in billing-ui.js where it is unit-tested.
 */
export function PlanCard({
  plan, currentTier, currentInterval, period, eligibility, onSelect, onCancel, busy, featured = false,
}) {
  const isCurrent = plan.id === currentTier;
  const isFree = plan.id === PLAN_IDS.FREE;
  const yearly = period === BILLING_INTERVAL.YEARLY;
  const needsEligibility = plan.requiresEligibility && !eligibility.eligible;
  const savings = yearlySavingsPercent(plan.id);
  const cta = planCta({ planId: plan.id, currentTier, interval: period, currentInterval });
  // "Most Popular" is for the plan we're recommending — never on the card the
  // merchant is already paying for, where it would be recommending a purchase
  // they have already made.
  const showsPopular = featured && !isCurrent;

  // Free has no yearly variant, so it reads "Free" in both modes rather than
  // showing $0/yr — a price that is technically true and reads as a mistake.
  const headlinePrice = isFree ? "Free" : yearly ? `$${plan.priceYearly}` : `$${plan.price}`;
  const priceCaption = isFree
    ? "Always free"
    : yearly
      ? `billed yearly · $${(plan.priceYearly / 12).toFixed(2)}/mo equivalent`
      : `per month${plan.requiresEligibility ? " per store" : ""}, billed monthly`;

  function handleClick() {
    if (cta.kind === "downgrade") return onCancel?.();
    return onSelect?.(period);
  }

  return (
    <div
      className={`iz-plan-cell${featured ? " iz-plan-cell--featured" : ""}`}
      data-plan-id={plan.id}
      data-featured={featured ? "true" : "false"}
      data-cta={cta.kind}
    >
      <div
        className="bg-white rounded-xl border shadow-sm flex flex-col p-5 h-full"
        style={{
          // The featured card's ring is drawn by the box-shadow in CSS, so it
          // must not also carry a coloured border or the two would stack into
          // a visibly thicker, slightly mismatched edge.
          borderColor: !featured && isCurrent ? S : "#e5e7eb",
          borderWidth: !featured && isCurrent ? 2 : 1,
        }}
      >
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <p className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>{plan.label}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {isCurrent && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-lg"
                style={{ background: "rgba(46,99,22,0.1)", color: S }}
              >
                Current plan
              </span>
            )}
            {showsPopular && <span className="iz-badge-vip">Most Popular</span>}
          </div>
        </div>

        <p className="mt-2 text-3xl font-bold text-gray-900" style={{ fontFamily: F }}>
          {headlinePrice}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">{priceCaption}</p>
        {!isFree && yearly && savings > 0 && (
          <p className="mt-0.5 text-xs font-semibold" style={{ color: S }}>You save {savings}%</p>
        )}
        {/* Trial disclosure — required on the plan page and stated up front,
            next to the price, not buried in a footnote. Shopify's approval
            screen shows it too (appSubscriptionCreate is sent with
            trialDays), but a reviewer looking at THIS page pre-subscribe
            must see it here. */}
        {!isFree && (
          <p className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold rounded-md px-2 py-0.5"
            style={{ background: "rgba(46,99,22,0.1)", color: S }}>
            {TRIAL_DAYS}-day free trial
          </p>
        )}

        {/* Fixed height so a longer description on one card cannot push its
            CTA out of line with the other two. */}
        <p className="mt-2 text-xs text-gray-500 leading-relaxed" style={{ minHeight: 40 }}>
          {plan.description}
        </p>

        <div className="mt-3 border-t border-gray-100" />

        <ul className="mt-3 space-y-2 flex-1">
          {planFeatures(plan).map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-xs text-gray-600">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" style={{ color: S }} aria-hidden="true">
                <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
              </svg>
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        {needsEligibility && (
          <p className="mt-3 text-[11px] text-amber-700 font-medium leading-relaxed">
            Unlocks at {AGENCY_MIN_STORES}+ stores — this account currently has {eligibility.storeCount}.
            You can still choose it; we&apos;ll flag the account and may ask you to move to Pro.
          </p>
        )}

        <button
          type="button"
          disabled={cta.disabled || busy}
          onClick={handleClick}
          className="mt-4 w-full px-4 py-2.5 text-sm rounded-lg font-semibold transition-all disabled:cursor-not-allowed"
          style={ctaStyle({ cta, featured, busy })}
        >
          {busy && !cta.disabled ? "Working…" : cta.label}
        </button>
      </div>
    </div>
  );
}

/**
 * The CTA's colours, by state.
 *
 * The featured card gets the deep-green gradient; ordinary upgrade buttons
 * get flat brand green; the disabled "Active plan" / "Included" states get a
 * neutral face so a card the merchant cannot act on never looks like the
 * loudest thing on the page; and Downgrade is a quiet outline, because it is
 * an exit, not an offer.
 */
function ctaStyle({ cta, featured, busy }) {
  if (cta.disabled) {
    return { background: "#f3f4f6", color: "#9ca3af", fontFamily: F, border: "1px solid #e5e7eb" };
  }
  if (cta.kind === "downgrade") {
    return { background: "#fff", color: "#6b7280", fontFamily: F, border: "1px solid #d1d5db", opacity: busy ? 0.5 : 1 };
  }
  if (featured) {
    return {
      background: `linear-gradient(180deg, ${S}, ${P})`,
      color: "#fff",
      fontFamily: F,
      border: `1px solid ${P}`,
      opacity: busy ? 0.6 : 1,
    };
  }
  return { background: S, color: "#fff", fontFamily: F, border: `1px solid ${S}`, opacity: busy ? 0.6 : 1 };
}

PlanCard.propTypes = {
  plan: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    price: PropTypes.number,
    priceYearly: PropTypes.number,
    recordLimit: PropTypes.number,
    scheduledSync: PropTypes.bool,
    builtInAi: PropTypes.bool,
    tagline: PropTypes.string,
    description: PropTypes.string,
    requiresEligibility: PropTypes.bool,
  }).isRequired,
  currentTier: PropTypes.string.isRequired,
  // What the shop is billed on today. Null when it is on Free, or when
  // Shopify returned no line items — planCta treats null as "unknown", which
  // is deliberately NOT the same as "a different period".
  currentInterval: PropTypes.string,
  // Which period the toggle is showing. Decides the price AND the charge.
  period: PropTypes.string.isRequired,
  eligibility: PropTypes.shape({
    eligible: PropTypes.bool,
    storeCount: PropTypes.number,
  }).isRequired,
  onSelect: PropTypes.func.isRequired,
  onCancel: PropTypes.func,
  busy: PropTypes.bool.isRequired,
  // Purely visual. Decided by isFeaturedPlan(planId, eligibility) in the
  // route — a function of the plan and the shop's store count, never of the
  // merchant's current tier. See its doc comment.
  featured: PropTypes.bool,
};
