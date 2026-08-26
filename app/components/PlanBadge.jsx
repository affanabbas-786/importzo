// ═══════════════════════════════════════════════════════════════════
// Persistent plan pill, top-right of every page in the app.
//
// Two jobs, and the second is why it is in the layout rather than on one
// page: it tells a merchant what they are on without making them go and
// look, and it keeps the number of records they have left in peripheral
// vision while they work. A quota you only discover on the Billing page
// is one you find out about by hitting it.
//
// It is a link, always, so "what am I on?" and "how do I change it?" are
// the same gesture.
// ═══════════════════════════════════════════════════════════════════

import PropTypes from "prop-types";
import { Link } from "react-router";
import { BRAND } from "../lib/constants";
import { usageTone } from "./UsageMeter";

// A four-point sparkle. Deliberately geometric and tiny — a paid-tier
// marker, not an illustration.
function SparkGlyph({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-shrink-0">
      <path d="M12 1.5l2.4 7.1 7.1 2.4-7.1 2.4-2.4 7.1-2.4-7.1L2.5 11l7.1-2.4z" fill="currentColor" />
    </svg>
  );
}
SparkGlyph.propTypes = { size: PropTypes.number };

const TONE_STYLES = {
  exhausted: { className: "bg-red-50 text-red-700 ring-red-200" },
  low: { className: "bg-amber-50 text-amber-800 ring-amber-200" },
  ok: { className: "bg-gray-50 text-gray-700 ring-gray-200" },
};

export function PlanBadge({ usage }) {
  if (!usage) return null;
  const tone = usageTone(usage);
  const paid = usage.isUnlimited;

  // Paid tiers get one treatment and capped tiers another, because they are
  // answering different questions. On Pro the useful fact is "you're on Pro";
  // on Free it's "you have N left".
  const body = paid ? (
    <>
      <SparkGlyph />
      <span>{usage.label}</span>
    </>
  ) : (
    <>
      <span>{usage.label}</span>
      <span aria-hidden="true" className="opacity-40">·</span>
      <span className="tabular-nums">
        {usage.remaining <= 0 ? "0 left" : `${usage.remaining.toLocaleString()} left`}
      </span>
    </>
  );

  const title = paid
    ? `You're on the ${usage.label} plan — unlimited records. Manage billing.`
    : `${usage.label} plan — ${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} records left this month. View plans.`;

  return (
    <Link
      to="/app/billing"
      title={title}
      aria-label={title}
      className={
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold " +
        "ring-1 transition-all hover:shadow-sm " +
        (paid ? "text-white ring-transparent" : TONE_STYLES[tone].className)
      }
      style={
        paid
          ? {
            background: `linear-gradient(135deg, ${BRAND.secondary} 0%, ${BRAND.primary} 100%)`,
            fontFamily: BRAND.font,
          }
          : { fontFamily: BRAND.font }
      }
    >
      {body}
    </Link>
  );
}

PlanBadge.propTypes = {
  usage: PropTypes.shape({
    label: PropTypes.string,
    limit: PropTypes.number,
    remaining: PropTypes.number,
    isUnlimited: PropTypes.bool,
  }),
};
