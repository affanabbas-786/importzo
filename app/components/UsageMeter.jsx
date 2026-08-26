// ═══════════════════════════════════════════════════════════════════
// Plan + remaining-records meter.
//
// Lives here rather than inside app.billing.jsx because the number only
// helps where the records are actually being SPENT. A merchant who finds
// out they were out of quota after starting a 5,000-product transfer
// learns it from a failed run; one who can see "180 left" before pressing
// Start does not start it.
//
// So the same component renders on Billing (where you go to check) and on
// Transfer (where you go to spend), from one definition — a divergence
// between "what Billing says you have" and "what Transfer says you have"
// would be worse than either number alone.
// ═══════════════════════════════════════════════════════════════════

import PropTypes from "prop-types";
import { Link } from "react-router";
import { BRAND } from "../lib/constants";
import { BILLING_INTERVAL } from "../lib/plans";

// Below this fraction remaining, the meter stops being neutral reporting
// and starts being a warning — early enough to act on, not so early that
// it cries wolf for most of the month.
const LOW_REMAINING_FRACTION = 0.2;

export function usageTone(usage) {
  if (usage.isUnlimited) return "unlimited";
  if (usage.remaining <= 0) return "exhausted";
  if (usage.limit > 0 && usage.remaining / usage.limit <= LOW_REMAINING_FRACTION) return "low";
  return "ok";
}

const BAR = {
  ok: BRAND.secondary,
  low: "#b45309",
  exhausted: "#dc2626",
};

export function UsageMeter({ usage, showUpgrade = false, className = "" }) {
  const tone = usageTone(usage);
  const pct = usage.isUnlimited
    ? 100
    : Math.min(100, Math.round((usage.used / Math.max(usage.limit, 1)) * 100));

  const intervalLabel =
    usage.interval === BILLING_INTERVAL.YEARLY ? " · billed yearly"
      : usage.interval === BILLING_INTERVAL.MONTHLY ? " · billed monthly"
        : "";

  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-sm p-5 ${className}`}>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: BRAND.font }}>
            Current plan: {usage.label}{intervalLabel}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {usage.isUnlimited
              ? "Unlimited records this month"
              : `${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} records used this month`}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {tone === "exhausted" && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700">
              Monthly limit reached
            </span>
          )}
          {tone === "low" && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-800">
              {usage.remaining.toLocaleString()} left
            </span>
          )}
          {/* Deliberately not shown on an unlimited plan: there is nothing to
              upgrade to, and a dead "Upgrade" button reads as a bug. */}
          {showUpgrade && !usage.isUnlimited && (
            <Link
              to="/app/billing"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white transition-opacity hover:opacity-90"
              style={{ background: BRAND.secondary }}
            >
              {tone === "exhausted" ? "Upgrade to continue" : "Upgrade"}
            </Link>
          )}
        </div>
      </div>

      {!usage.isUnlimited && (
        <>
          <div className="mt-3 h-2 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: BAR[tone] }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {tone === "exhausted"
              ? "New records won't be written until the next billing period, or until you upgrade."
              : `${usage.remaining.toLocaleString()} records remaining this month.`}
          </p>
        </>
      )}
    </div>
  );
}

UsageMeter.propTypes = {
  usage: PropTypes.shape({
    label: PropTypes.string,
    used: PropTypes.number,
    limit: PropTypes.number,
    remaining: PropTypes.number,
    isUnlimited: PropTypes.bool,
    interval: PropTypes.string,
  }).isRequired,
  showUpgrade: PropTypes.bool,
  className: PropTypes.string,
};
