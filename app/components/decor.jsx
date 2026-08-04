// ═══════════════════════════════════════════════════════════════════
// Decorative leaf/plant components — leafy visual refresh.
//
// Reserved for decorative/branded surfaces (Dashboard, Settings section
// headers, empty states, onboarding) per the design brief. Deliberately
// NOT used on transactional screens (Transfer wizard, Activity table,
// error/destructive-confirmation UI) — those stay Polaris-plain so they
// read as precise, not decorated.
//
// All shapes are hand-authored inline SVG (no external assets) so there's
// nothing to fetch, cache-bust, or attribute. Every element here is
// `pointer-events-none` and `aria-hidden` — decoration only, never a
// click target or a screen-reader announcement.
// ═══════════════════════════════════════════════════════════════════

import PropTypes from "prop-types";
import { COLORS } from "../lib/design-tokens";

// Single leaf glyph — an almond body (two mirrored arcs) with a center
// vein. Used standalone as a small accent icon, and repeated/rotated to
// build the corner clusters and empty-state illustration below.
function LeafShape({ fill = COLORS.secondary, opacity = 1 }) {
  return (
    <path
      d="M12 2C7 4 3 9 3 14c0 4.5 4 7 9 7s9-2.5 9-7C21 9 17 4 12 2z
         M12 4.5v15"
      fill={fill}
      fillOpacity={opacity}
      stroke="none"
    />
  );
}
LeafShape.propTypes = { fill: PropTypes.string, opacity: PropTypes.number };

// Small single-leaf accent icon — used inline next to section headers.
// Intentionally tiny and low-contrast; a motif, not an illustration.
export function LeafIcon({ size = 16, color = COLORS.secondary, className = "" }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      className={className} aria-hidden="true"
    >
      <LeafShape fill={color} />
      <path d="M12 4.5v15" stroke="#fff" strokeOpacity={0.35} strokeWidth={0.75} />
    </svg>
  );
}
LeafIcon.propTypes = { size: PropTypes.number, color: PropTypes.string, className: PropTypes.string };

const CORNER_TRANSFORM = {
  "top-right": "scale(1,1)",
  "top-left": "scale(-1,1) translate(-100%, 0)",
  "bottom-right": "scale(1,-1) translate(0,-100%)",
  "bottom-left": "scale(-1,-1) translate(-100%,-100%)",
};

const CORNER_POSITION = {
  "top-right": { top: 0, right: 0 },
  "top-left": { top: 0, left: 0 },
  "bottom-right": { bottom: 0, right: 0 },
  "bottom-left": { bottom: 0, left: 0 },
};

// A loose cluster of overlapping, pale leaves anchored to one corner of a
// container. Meant to sit behind real content (low opacity, muted tones)
// — the container needs `position: relative; overflow: hidden`.
export function DecorativeCorner({ position = "top-right", size = 120, className = "" }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 120 120" fill="none"
      className={`absolute pointer-events-none select-none ${className}`}
      style={{ ...CORNER_POSITION[position], transform: CORNER_TRANSFORM[position] }}
      aria-hidden="true"
    >
      <g transform="translate(30,2) rotate(18) scale(1.85)" opacity="0.95">
        <LeafShape fill={COLORS.leafLight} />
      </g>
      <g transform="translate(56,20) rotate(-8) scale(1.35)" opacity="0.9">
        <LeafShape fill={COLORS.leafMid} />
      </g>
      <g transform="translate(20,30) rotate(42) scale(1)" opacity="0.85">
        <LeafShape fill={COLORS.secondary} opacity={0.6} />
      </g>
      <g transform="translate(48,46) rotate(-32) scale(0.7)" opacity="0.75">
        <LeafShape fill={COLORS.leafDeep} opacity={0.5} />
      </g>
    </svg>
  );
}
DecorativeCorner.propTypes = {
  position: PropTypes.oneOf(["top-right", "top-left", "bottom-right", "bottom-left"]),
  size: PropTypes.number,
  className: PropTypes.string,
};

// Friendly sprouting-plant illustration for empty states / onboarding —
// a simple pot with three leaves. Replaces the generic gray
// icon-in-a-circle used elsewhere in the app for decorative surfaces.
export function EmptyStateIllustration({ size = 96, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" className={className} aria-hidden="true">
      <circle cx="48" cy="48" r="46" fill={COLORS.leafLight} />
      <g transform="translate(48,52) rotate(-16) scale(1.3)">
        <LeafShape fill={COLORS.secondary} />
      </g>
      <g transform="translate(38,50) rotate(14) scale(0.95)">
        <LeafShape fill={COLORS.leafDeep} />
      </g>
      <g transform="translate(58,50) rotate(-38) scale(0.8)">
        <LeafShape fill={COLORS.leafMid} />
      </g>
      <path d="M32 62h32l-4 16a4 4 0 01-4 3.4H40a4 4 0 01-4-3.4l-4-16z" fill={COLORS.primary} />
      <path d="M30 62h36" stroke={COLORS.leafLight} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
EmptyStateIllustration.propTypes = { size: PropTypes.number, className: PropTypes.string };

// Warm decorative surface for welcome banners / top-of-page sections on
// branded pages. A soft cream→leaf gradient wash with corner leaf accents
// behind the real content. Never used on transactional pages.
export function DecorativeBanner({ children, className = "", cornerPosition = "top-right" }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl ${className}`}
      style={{
        background: `linear-gradient(135deg, ${COLORS.cream} 0%, ${COLORS.leafLight} 100%)`,
        boxShadow: "0 1px 2px rgba(16,24,8,0.04), 0 4px 12px rgba(16,24,8,0.05)",
      }}
    >
      <DecorativeCorner position={cornerPosition} size={170} className="opacity-90" />
      {cornerPosition === "top-right" && (
        <DecorativeCorner position="bottom-left" size={110} className="opacity-55" />
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
