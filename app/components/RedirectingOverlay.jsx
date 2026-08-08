import PropTypes from "prop-types";
import { BRAND } from "../lib/constants";

const { primary: P, font: F } = BRAND;

/**
 * Phase 9 — the "we're taking you to Shopify" overlay.
 *
 * Shown from the moment a plan button is clicked until the browser actually
 * leaves for admin.shopify.com, which under Shopify App Pricing is a full
 * top-level navigation and routinely takes a few seconds. Purely
 * presentational: it renders what it is told and owns no state, so the
 * question of when it appears (and, more importantly, when it does NOT
 * disappear) lives in billing-ui.js where it can be tested.
 *
 * alertdialog rather than dialog: this announces an action already in
 * progress and offers no choice — there is deliberately no dismiss control,
 * because dismissing it would not cancel the navigation it is describing.
 */
export function RedirectingOverlay({ open, title, timing, reassurance }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-[2px] animate-fade-in"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="redirecting-overlay-title"
      aria-describedby="redirecting-overlay-body"
    >
      <div className="bg-white rounded-xl shadow-xl border border-gray-200 max-w-sm w-full p-6 text-center">
        <svg
          className="w-8 h-8 mx-auto animate-spin"
          style={{ color: P }}
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>

        <p
          id="redirecting-overlay-title"
          className="mt-4 text-sm font-semibold text-gray-900"
          style={{ fontFamily: F }}
        >
          {title}
        </p>

        <div id="redirecting-overlay-body">
          <p className="mt-1.5 text-xs text-gray-500">{timing}</p>
          <p className="mt-3 text-xs text-gray-600 leading-relaxed">{reassurance}</p>
        </div>
      </div>
    </div>
  );
}

RedirectingOverlay.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  timing: PropTypes.string.isRequired,
  reassurance: PropTypes.string.isRequired,
};
