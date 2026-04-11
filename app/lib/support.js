// ═══════════════════════════════════════════════════════════════════
// Importzo — Support Config
// Central place for support contact details. All in-app help links
// and CTAs should import from here instead of hardcoding addresses.
// ═══════════════════════════════════════════════════════════════════

export const SUPPORT_EMAIL = "support@dazzletech.co";

export const TAWK_SRC = "https://embed.tawk.to/69d164c7e360ca1c3ce302f1/1jlcv3bqf";

export function mailtoLink(subject = "Importzo Support", body = "") {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  return `mailto:${SUPPORT_EMAIL}?${params.toString()}`;
}

// Opens the tawk.to widget if it has been loaded. Falls back to mailto.
export function openLiveChat() {
  if (typeof window === "undefined") return;
  // eslint-disable-next-line no-undef
  const api = window.Tawk_API;
  if (api && typeof api.maximize === "function") {
    try { api.maximize(); return; } catch (_) { /* fall through */ }
  }
  // Fallback — open support email if chat isn't ready yet.
  window.location.href = mailtoLink("Importzo — I need help");
}
