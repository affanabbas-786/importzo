// ═══════════════════════════════════════════════════════════════════
// Decorative surfaces — soft gradient washes and an empty-state mark.
//
// These used to be hand-drawn leaves. They were replaced because a plant
// motif says nothing about what this app does: Importzo moves catalogs
// between stores, and the decoration should either reinforce that or get
// out of the way. What is left does both — abstract light on branded
// surfaces, and, where an illustration genuinely helps (empty states), a
// store-to-store mark rather than a houseplant.
//
// Reserved for decorative/branded surfaces (Dashboard, Settings section
// headers, empty states). Deliberately NOT used on transactional screens
// (Transfer wizard, Activity table, destructive confirmations) — those
// stay plain so they read as precise, not decorated.
//
// Everything here is inline SVG/CSS (no external assets), and every
// element is `pointer-events-none` and `aria-hidden` — decoration only,
// never a click target or a screen-reader announcement.
// ═══════════════════════════════════════════════════════════════════

import PropTypes from "prop-types";
import { COLORS } from "../lib/design-tokens";

const CORNER_POSITION = {
  "top-right": { top: 0, right: 0 },
  "top-left": { top: 0, left: 0 },
  "bottom-right": { bottom: 0, right: 0 },
  "bottom-left": { bottom: 0, left: 0 },
};

/**
 * A soft radial bloom anchored to one corner, behind real content.
 *
 * A blurred gradient rather than shapes: it reads as light on the surface
 * instead of as objects sitting on it, so nothing competes with the text
 * in front. The container needs `position: relative; overflow: hidden`.
 */
export function DecorativeCorner({ position = "top-right", size = 120, className = "" }) {
  const id = `bloom-${position}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 120 120" fill="none"
      className={`absolute pointer-events-none select-none ${className}`}
      style={CORNER_POSITION[position]}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={id} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={COLORS.washMid} stopOpacity="0.75" />
          <stop offset="55%" stopColor={COLORS.washLight} stopOpacity="0.35" />
          <stop offset="100%" stopColor={COLORS.washLight} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="60" fill={`url(#${id})`} />
      {/* Two hairline arcs, barely visible — enough to give the wash an
          edge so it doesn't read as a printing artifact. */}
      <circle cx="60" cy="60" r="38" stroke={COLORS.secondary} strokeOpacity="0.07" strokeWidth="1" />
      <circle cx="60" cy="60" r="54" stroke={COLORS.secondary} strokeOpacity="0.05" strokeWidth="1" />
    </svg>
  );
}
DecorativeCorner.propTypes = {
  position: PropTypes.oneOf(["top-right", "top-left", "bottom-right", "bottom-left"]),
  size: PropTypes.number,
  className: PropTypes.string,
};

/**
 * Empty-state mark: two stores, and something moving between them.
 *
 * The one place an illustration earns its space in this app, because the
 * empty state is exactly where a merchant has not yet understood what the
 * product does. Two cards and a directed arc say it without a caption.
 */
export function EmptyStateIllustration({ size = 96, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="es-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={COLORS.washLight} />
          <stop offset="100%" stopColor={COLORS.washMid} />
        </linearGradient>
      </defs>
      <circle cx="48" cy="48" r="46" fill="url(#es-bg)" />

      {/* Source card — lighter, "full" */}
      <rect x="16" y="34" width="26" height="30" rx="5" fill="#fff" stroke={COLORS.secondary} strokeOpacity="0.35" />
      <rect x="20" y="40" width="18" height="2.5" rx="1.25" fill={COLORS.secondary} fillOpacity="0.45" />
      <rect x="20" y="46" width="13" height="2.5" rx="1.25" fill={COLORS.secondary} fillOpacity="0.3" />
      <rect x="20" y="52" width="16" height="2.5" rx="1.25" fill={COLORS.secondary} fillOpacity="0.3" />

      {/* Destination card — outlined, "waiting" */}
      <rect x="54" y="34" width="26" height="30" rx="5" fill="#fff" stroke={COLORS.secondary} strokeOpacity="0.25" strokeDasharray="3 3" />

      {/* The move itself */}
      <path d="M44 44c4-6 8-6 12 0" stroke={COLORS.primary} strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M52 40.5l4.5 3.5-4.5 3.5z" fill={COLORS.primary} fillOpacity="0.7" />
    </svg>
  );
}
EmptyStateIllustration.propTypes = { size: PropTypes.number, className: PropTypes.string };

/**
 * Warm decorative surface for welcome banners / top-of-page sections on
 * branded pages. A soft wash with a corner bloom behind the real content.
 * Never used on transactional pages.
 */
export function DecorativeBanner({ children, className = "", cornerPosition = "top-right" }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl ${className}`}
      style={{
        background: `linear-gradient(135deg, ${COLORS.cream} 0%, ${COLORS.washLight} 100%)`,
        boxShadow: "0 1px 2px rgba(16,24,8,0.04), 0 4px 12px rgba(16,24,8,0.05)",
      }}
    >
      <DecorativeCorner position={cornerPosition} size={190} className="opacity-90" />
      {cornerPosition === "top-right" && (
        <DecorativeCorner position="bottom-left" size={130} className="opacity-50" />
      )}
      <div className="relative">{children}</div>
    </div>
  );
}
DecorativeBanner.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
  cornerPosition: PropTypes.oneOf(["top-right", "top-left", "bottom-right", "bottom-left"]),
};
