// ═══════════════════════════════════════════════════════════════════
// Design tokens — leafy visual refresh (decorative areas only).
//
// Single source of truth for the palette/spacing/shadow values used by
// the decorative treatment (welcome banners, empty states, corner
// accents). Reuses the app's existing brand greens from constants.js
// rather than introducing a new shade, so buttons/links/active-states
// that already use BRAND.primary/secondary stay visually identical —
// this file only adds the *decorative* tokens layered on top.
// ═══════════════════════════════════════════════════════════════════

import { BRAND } from "./constants";

export const COLORS = {
  primary: BRAND.primary,     // #17320A — deep forest green
  secondary: BRAND.secondary, // #2E6316 — brand green
  primaryTint: "rgba(23,50,10,0.08)",
  secondaryTint: "rgba(46,99,22,0.07)",
  leafLight: "#E8F1E2",   // pale leaf-green fill, decorative shapes only
  leafMid: "#BFDCAE",
  leafDeep: "#4C7A34",
  cream: "#FBFAF6",       // warm wash background for decorative banners
};

// 12–16px per the design brief; two sizes so nested/smaller cards can
// stay slightly tighter than a top-level section card.
export const RADIUS = {
  card: 16,
  cardSm: 12,
};

export const SHADOW = {
  card: "0 1px 2px rgba(16,24,8,0.04), 0 4px 12px rgba(16,24,8,0.05)",
  cardHover: "0 4px 10px rgba(16,24,8,0.06), 0 14px 28px rgba(16,24,8,0.09)",
};

export const FONT = BRAND.font;
