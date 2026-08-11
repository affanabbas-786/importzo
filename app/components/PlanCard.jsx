import PropTypes from "prop-types";
import { PLAN_IDS, AGENCY_MIN_STORES, TRIAL_DAYS, yearlySavingsPercent } from "../lib/plans.js";
import { planActionLabel, offersPlanSelection, freeCardLink } from "../lib/billing-ui.js";
import { BRAND } from "../lib/constants";

const { primary: P, secondary: S, font: F } = BRAND;

// The featured card's lift, drawn as a shadow in the brand green rather than
// neutral grey so the elevation reads as part of the highlight instead of as a
// heavier version of the same card. Second layer is the ordinary ambient
// shadow the other two cards get from `shadow-sm`, kept so the card still
// sits on the page rather than floating off it.
const FEATURED_SHADOW = "0 18px 40px -12px rgba(46,99,22,.38), 0 2px 6px rgba(23,50,10,.06)";

/**
 * Phase 9 — lifted out of app.billing.jsx so it can be rendered directly in
 * a test. What a merchant is actually promised by a button ("Upgrade to
 * Pro", and which cards get one at all) is billing behaviour, not
 * decoration, and it was previously asserted nowhere.
 *
 * Presentational only: every decision it renders comes from billing-ui.js.
 */
export function PlanCard({ plan, currentTier, eligibility, onSelect, busy, planSelectionUrl, featured = false }) {
  const isCurrent = plan.id === currentTier;
  const isFree = plan.id === PLAN_IDS.FREE;
  const needsEligibility = plan.requiresEligibility && !eligibility.eligible;
  const savings = yearlySavingsPercent(plan.id);
  const showsButton = offersPlanSelection({ planId: plan.id, currentTier });
  // Free's alternative to a plan-selection button — a link, for the merchant
  // on a paid plan who wants off it. Null for a merchant already on Free.
  const downgrade = isFree ? freeCardLink({ currentTier }) : null;
  // Green border for the featured card and for the merchant's current one.
  // Both reasons produce the same 2px green edge; a card that is both simply
  // keeps it once.
  const emphasised = featured || isCurrent;

  return (
    <div
      data-plan-id={plan.id}
      data-featured={featured ? "true" : "false"}
      // `sm:-mt-6` is the lift, and it is what makes this card taller as well
      // as higher: grid items stretch to the row height by default, so pulling
      // the top edge up by 24px grows the border box by the same 24px rather
      // than sliding a fixed-height box upwards. Below the `sm` breakpoint the
      // grid is a single column and the lift is dropped entirely — a card
      // hanging 24px above the one before it only reads as "featured" when
      // there is something beside it to be raised above.
      className={`bg-white rounded-xl border shadow-sm flex flex-col ${
        featured ? "p-6 sm:-mt-6 relative z-10" : "p-5"
      }`}
      style={{
        borderColor: emphasised ? S : "#e5e7eb",
        borderWidth: emphasised ? 2 : 1,
        ...(featured ? { boxShadow: FEATURED_SHADOW } : null),
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <p className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>{plan.label}</p>
          {featured && (
            <span
              className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 text-white"
              style={{ background: `linear-gradient(135deg, ${P} 0%, ${S} 100%)`, fontFamily: F }}
            >
              Most Popular
            </span>
          )}
        </div>
        {isCurrent && (
          <span className="text-xs font-semibold px-2 py-1 rounded-full flex-shrink-0" style={{ background: "rgba(46,99,22,0.1)", color: S }}>
            Current plan
          </span>
        )}
      </div>
      <p className="mt-1 text-2xl font-bold text-gray-900" style={{ fontFamily: F }}>
        {plan.price === 0 ? "Free" : `$${plan.price}`}
        {plan.price > 0 && <span className="text-sm font-medium text-gray-400">/mo{plan.requiresEligibility ? " per store" : ""}</span>}
      </p>
      {plan.priceYearly > 0 && (
        <p className="mt-0.5 text-xs text-gray-500">
          or <strong className="text-gray-700">${plan.priceYearly}/year</strong>
          {savings > 0 && <span className="ml-1 font-semibold" style={{ color: S }}>save {savings}%</span>}
        </p>
      )}
      <p className="mt-1.5 text-xs text-gray-500">{plan.tagline}</p>
      <p className="mt-2 text-xs text-gray-500 leading-relaxed flex-1">{plan.description}</p>

      {needsEligibility && (
        <p className="mt-3 text-[11px] text-amber-700 font-medium leading-relaxed">
          Unlocks at {AGENCY_MIN_STORES}+ stores — this merchant currently has {eligibility.storeCount}.
          Shopify&apos;s plan page will still let you pick it, but we&apos;ll flag the account and may ask you to
          move to Pro.
        </p>
      )}

      {showsButton && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onSelect}
            className="mt-4 px-4 py-2 text-sm rounded-lg shadow-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110"
            style={{ background: P, color: "#fff", fontFamily: F }}
          >
            {busy ? "Redirecting…" : planActionLabel(plan, currentTier)}
          </button>
          <p className="mt-2 text-[11px] text-gray-400">{TRIAL_DAYS}-day free trial · monthly or yearly, chosen on Shopify&apos;s page</p>
        </>
      )}

      {downgrade && (
        <div className="mt-4">
          <a
            href={planSelectionUrl}
            target="_top"
            className="text-xs font-semibold hover:underline"
            style={{ color: S }}
          >
            {downgrade.label}
          </a>
          <p className="mt-1 text-[11px] text-gray-400">{downgrade.description}</p>
        </div>
      )}
    </div>
  );
}

PlanCard.propTypes = {
  plan: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    price: PropTypes.number,
    priceYearly: PropTypes.number,
    tagline: PropTypes.string,
    description: PropTypes.string,
    requiresEligibility: PropTypes.bool,
  }).isRequired,
  currentTier: PropTypes.string.isRequired,
  eligibility: PropTypes.shape({
    eligible: PropTypes.bool,
    storeCount: PropTypes.number,
  }).isRequired,
  onSelect: PropTypes.func.isRequired,
  busy: PropTypes.bool.isRequired,
  planSelectionUrl: PropTypes.string.isRequired,
  // Purely visual. Decided by isFeaturedPlan(planId, eligibility) in the
  // route — a function of the plan and the shop's store count, never of the
  // merchant's current tier. See its doc comment.
  featured: PropTypes.bool,
};
