// ═══════════════════════════════════════════════════════════════════
// Importzo — User preferences
//
// Lightweight client-side preference store backed by localStorage.
// These are reasonable per-merchant defaults (duplicate handling,
// dry-run, overwrite safety) that the Transfer / Import flows read
// before starting a new job. Keeping this client-side avoids a Prisma
// schema change for this pass — if we later want per-store preferences,
// promote the same keys to a `Preference` table.
// ═══════════════════════════════════════════════════════════════════

const KEY = "importzo.prefs.v1";

export const DEFAULT_PREFS = Object.freeze({
  duplicateHandling: "skip",     // "skip" | "create" | "overwrite"
  dryRunByDefault: false,
  confirmDestructive: true,
  autoDownloadErrorReports: true,
  notifyOnComplete: true,        // browser notification when job finishes
  notifySound: false,            // play a sound on completion
});

function safeParse(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPrefs() {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  try {
    const stored = safeParse(window.localStorage.getItem(KEY));
    return { ...DEFAULT_PREFS, ...stored };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch) {
  if (typeof window === "undefined") return;
  try {
    const current = loadPrefs();
    const next = { ...current, ...patch };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable (private mode / iframe). We silently
    // accept this — the default values will apply until storage works.
  }
}

export function resetPrefs() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

export function canPersist() {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem("__importzo_chk__", "1");
    window.localStorage.removeItem("__importzo_chk__");
    return true;
  } catch {
    return false;
  }
}
