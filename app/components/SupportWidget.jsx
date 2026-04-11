// ═══════════════════════════════════════════════════════════════════
// Importzo — Support Widget Loader
// Loads the tawk.to live-chat script once, client-side only. Placed in
// the app shell so every page gets chat without duplicated scripts.
// ═══════════════════════════════════════════════════════════════════

import { useEffect } from "react";
import { TAWK_SRC } from "../lib/support";

const MOUNT_ID = "importzo-tawk-loader";

export function SupportWidget() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    // Avoid double-injection across soft navigations / hot reloads.
    if (document.getElementById(MOUNT_ID)) return;
    // eslint-disable-next-line no-undef
    if (window.Tawk_API) return;

    // eslint-disable-next-line no-undef
    window.Tawk_API = window.Tawk_API || {};
    // eslint-disable-next-line no-undef
    window.Tawk_LoadStart = new Date();

    const script = document.createElement("script");
    script.id = MOUNT_ID;
    script.async = true;
    script.src = TAWK_SRC;
    script.charset = "UTF-8";
    script.setAttribute("crossorigin", "*");
    // Append to body to avoid blocking head parsing.
    document.body.appendChild(script);

    // No cleanup on unmount — the widget should persist across route changes.
  }, []);

  return null;
}
