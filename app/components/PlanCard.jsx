import PropTypes from "prop-types";
import { PLAN_IDS, AGENCY_MIN_STORES, TRIAL_DAYS, yearlySavingsPercent } from "../lib/plans.js";
import { planActionLabel, offersPlanSelection, freeCardLink } from "../lib/billing-ui.js";
import { BRAND } from "../lib/constants";

const { primary: P, secondary: S, font: F } = BRAND;

/**
 * Phase 9 — lifted out of app.billing.jsx so it can be rendered directly in
 * a test. What a merchant is actually promised by a button ("Upgrade to
 * Pro", and which cards get one at all) is billing behaviour, not
 * decoration, and it was previously asserted nowhere.
 *
 * Presentational only: every decision it renders comes from billing-ui.js.
 */
export function PlanCard({ plan, currentTier, eligibility, onSelect, busy, planSelectionUrl }) {
  const isCurrent = plan.id === currentTier;
  const isFree = plan.id === PLAN_IDS.FREE;
  const needsEligibility = plan.requiresEligibility && !eligibility.eligible;
  const savings = yearlySavingsPercent(plan.id);
  const showsButton = offersPlanSelection({ planId: plan.id, currentTier });
  // Free's alternative to a plan-selection button — a link, for the merchant
  // on a paid plan who wants off it. Null for a merchant already on Free.
  const downgrade = isFree ? freeCardLink({ currentTier }) : null;

  return (
    <div
      className="bg-white rounded-xl border shadow-sm p-5 flex flex-col"
      style={{ borderColor: isCurrent ? S : "#e5e7eb", borderWidth: isCurrent ? 2 : 1 }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>{plan.label}</p>
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
};
