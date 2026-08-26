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

      {/* Source — populated */}
      <rect x="13" y="33" width="27" height="30" rx="5" fill="#fff" stroke={COLORS.secondary} strokeOpacity="0.4" strokeWidth="1.5" />
      <rect x="18" y="40" width="17" height="3" rx="1.5" fill={COLORS.secondary} fillOpacity="0.5" />
      <rect x="18" y="46.5" width="12" height="3" rx="1.5" fill={COLORS.secondary} fillOpacity="0.32" />
      <rect x="18" y="53" width="15" height="3" rx="1.5" fill={COLORS.secondary} fillOpacity="0.32" />

      {/* Destination — waiting */}
      <rect x="56" y="33" width="27" height="30" rx="5" fill="#fff" stroke={COLORS.secondary} strokeOpacity="0.3" strokeWidth="1.5" strokeDasharray="4 3" />

      {/* The move, entirely inside the 16px gap between the two cards. The
          previous arc ran from x=44 to x=56 — overlapping both cards — and
          collapsed into a smudge at the 88px this actually renders at. */}
      <path d="M43 48h8" stroke={COLORS.primary} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M50 43.5L54.5 48 50 52.5z" fill={COLORS.primary} />
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
