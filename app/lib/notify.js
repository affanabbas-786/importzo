// ═══════════════════════════════════════════════════════════════════
// Importzo — Browser notification helper
//
// Fires a desktop notification + optional chime when a job completes.
// Reads the user's notification prefs from localStorage. No-ops
// silently when notifications aren't supported or allowed.
// ═══════════════════════════════════════════════════════════════════

import { loadPrefs } from "./prefs";

export function notifyJobComplete(title, body) {
  if (typeof window === "undefined") return;
  const prefs = loadPrefs();

  // Browser notification
  if (prefs.notifyOnComplete && window.Notification && Notification.permission === "granted") {
    try { new Notification(title, { body, icon: "/logo.png" }); } catch { /* ignore */ }
  }

  // Completion sound — short inline-generated beep via Web Audio API
  if (prefs.notifySound) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.value = 0.15;
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch { /* ignore */ }
  }
}
