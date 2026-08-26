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

// Where the light comes from, as a CSS gradient origin.
const CORNER_ORIGIN = {
  "top-right": "100% 0%",
  "top-left": "0% 0%",
  "bottom-right": "100% 100%",
  "bottom-left": "0% 100%",
};

/**
 * Light falling across one corner of a surface.
 *
 * A CSS gradient anchored AT the corner, not an SVG shape placed near it.
 * The earlier version drew a circle in a box pinned to the corner, which put
 * its brightest point ~95px inside the card — a green smudge floating over
 * the text rather than an accent — and its two hairline rings read as a
 * target. Anchoring the gradient origin to the corner itself means the
 * falloff has no centre to notice.
 *
 * The container needs `position: relative; overflow: hidden`.
 */
export function DecorativeCorner({ position = "top-right", extent = 125, className = "" }) {
  return (
    <div
      aria-hidden="true"
      className={`absolute inset-0 pointer-events-none select-none ${className}`}
      style={{
        background:
          `radial-gradient(${extent}% ${extent - 10}% at ${CORNER_ORIGIN[position]}, ` +
          `rgba(46,99,22,0.15) 0%, rgba(46,99,22,0.045) 36%, transparent 64%)`,
      }}
    />
  );
}
DecorativeCorner.propTypes = {
  position: PropTypes.oneOf(["top-right", "top-left", "bottom-right", "bottom-left"]),
  extent: PropTypes.number,
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
 * Decorative surface for welcome banners and top-of-page sections on branded
 * pages. Near-white paper, a green-biased hairline border for definition, and
 * light across one corner. Never used on transactional pages.
 */
export function DecorativeBanner({ children, className = "", cornerPosition = "top-right" }) {
  const atTop = cornerPosition.startsWith("top");
  const atRight = cornerPosition.endsWith("right");
  return (
    <div
      className={`relative overflow-hidden rounded-2xl ${className}`}
      style={{
        background: COLORS.paper,
        border: `1px solid ${COLORS.hairline}`,
        boxShadow: "0 1px 2px rgba(16,24,8,0.04)",
      }}
    >
      <DecorativeCorner position={cornerPosition} />
      {/* A single lit edge on the same side as the wash. Without it the card
          has no crisp boundary and the whole block reads as slightly out of
          focus. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute", left: 0, right: 0, height: 1,
          [atTop ? "top" : "bottom"]: 0,
          background: `linear-gradient(${atRight ? "270deg" : "90deg"}, ${COLORS.hairlineStrong}, rgba(46,99,22,0) 60%)`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
DecorativeBanner.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
  cornerPosition: PropTypes.oneOf(["top-right", "top-left", "bottom-right", "bottom-left"]),
};
