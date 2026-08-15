// ═══════════════════════════════════════════════════════════════════
// Live access tokens for background work.
//
// THE BUG THIS EXISTS TO FIX
//
// Offline access tokens are EXPIRING on this app (shopify.server.js sets
// `future.expiringOfflineAccessTokens: true`, which must match the Partner
// Dashboard). Measured against the live Session table, an offline token is
// valid for SIXTY MINUTES; the refresh token that renews it lasts 90 days.
//
// Every background path in this app used to snapshot `session.accessToken`
// into a database row and then use that copy, unchanged, for the entire life
// of the work:
//
//   api.migration-job.jsx      destToken/sourceToken written onto MigrationJob
//   scheduled-sync.server.js   destToken copied from ScheduledSync onto the job
//   api.migration-status       auto-resume re-runs the worker on the SAME row
//
// For a catalog that transfers in under an hour on a freshly-opened session,
// that works, which is exactly why it survived. It breaks in the three cases
// that matter most:
//
//   1. A large migration (the 50k-product case this worker was built for)
//      runs for hours. Sixty minutes in, every productCreate starts coming
//      back 401. The worker catches that per-product, marks the product
//      FAILED and keeps going — so the job runs to "completion" having
//      silently failed everything after the first hour.
//   2. A job resumed after a PM2 restart, hours or days later, decrypts a
//      token that expired long ago. Same outcome, from the first product.
//   3. A scheduled sync uses a token snapshotted when the SCHEDULE was
//      created. By the time it fires — by design, days or weeks later — the
//      token is guaranteed dead. Scheduled sync could never have worked.
//
// THE FIX
//
// Resolve the token at the moment of use, from the session store, through
// `unauthenticated.admin(shop)`. That call runs the library's
// ensureValidOfflineSession → ensureOfflineTokenIsNotExpired path, which
// renews from the stored refresh token whenever the access token is within
// five minutes of expiry and writes the new one back to the Session row. So
// asking for the token is also what keeps it alive.
//
// The stored (encrypted) token stays as a fallback rather than being deleted,
// because not every shop in a transfer has a session to refresh from:
//
//   - The SOURCE store is often connected by a pasted custom-app token
//     (shpat_…), which never expires and has no Session row at all.
//   - A destination whose app was uninstalled mid-job has no session either.
//
// In both cases there is nothing to refresh and the snapshot is the best
// available answer, so we serve it rather than failing the job outright.
// ═══════════════════════════════════════════════════════════════════

// How long a resolved token is reused before going back to the session store.
// Well inside the 60-minute token lifetime, so a refresh always happens with
// room to spare, and long enough that a busy worker isn't re-reading the
// session on every batch.
export const DEFAULT_TTL_MS = 20 * 60 * 1000;

// Backoff after a failed resolve, so a shop with no session (the pasted-token
// case) doesn't cause a session lookup on every single batch for the whole job.
export const RESOLVE_RETRY_MS = 5 * 60 * 1000;

/**
 * True for the errors that mean "this token is no longer good" — as opposed to
 * a transient network or server-side failure, where re-resolving would not
 * help and retrying the operation is the right response.
 *
 * shopifyGraphql throws `GraphQL HTTP <status>: <body>` (see
 * shopify-api.server.js), so status matching happens on the message. 401 is
 * an expired/revoked token; 403 is a scope or permission problem, which a
 * refresh does not fix but is worth one re-resolve in case the session was
 * re-granted with wider scopes.
 */
export function isAuthError(error) {
  const message = String(error?.message || error || "");
  return /GraphQL HTTP 40[13]\b/.test(message) ||
    /\b(unauthorized|invalid[_ ]token|access token)\b/i.test(message);
}

/**
 * Default session lookup. Imported lazily so that unit tests — and any module
 * that merely imports a worker — don't pull shopify.server.js (and with it
 * shopifyApp() construction plus the ENCRYPTION_KEY boot assertion) into the
 * module graph unless a token is actually resolved.
 */
async function loadSessionToken(shop) {
  const { unauthenticated } = await import("../shopify.server.js");
  const { session } = await unauthenticated.admin(shop);
  return session?.accessToken || null;
}

/**
 * A token source for one shop.
 *
 * `get()` returns the freshest token it can: a cached one while still inside
 * the TTL, otherwise a newly-resolved (and, if it was near expiry, renewed)
 * one from the session store. It NEVER throws and never returns null while a
 * fallback exists — a background job losing its ability to refresh should
 * degrade to the old behaviour, not abort a half-finished migration.
 *
 * `invalidate()` forces the next `get()` to re-resolve. Call it when a request
 * comes back 401 so the retry uses a genuinely new token instead of the one
 * that just failed.
 */
export function createTokenProvider({
  shop,
  fallbackToken = null,
  loadToken = loadSessionToken,
  ttlMs = DEFAULT_TTL_MS,
  retryMs = RESOLVE_RETRY_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let token = fallbackToken || null;
  let validUntil = 0;
  let refreshed = false;
  // Collapses concurrent get() calls (the worker runs CREATE_CONCURRENCY
  // products in parallel) onto a single session lookup.
  let inFlight = null;

  async function resolve() {
    try {
      const fresh = await loadToken(shop);
      if (fresh) {
        if (fresh !== token) {
          logger.log?.(`[job-tokens] refreshed access token for ${shop}`);
        }
        token = fresh;
        refreshed = true;
        validUntil = now() + ttlMs;
        return token;
      }
      // A session exists but carries no token — treat as unresolvable.
      throw new Error("session has no access token");
    } catch (err) {
      // Expected for pasted custom-app tokens and uninstalled shops. Warn
      // once per backoff window rather than on every batch.
      logger.warn?.(
        `[job-tokens] could not resolve a live token for ${shop} (${err?.message || err}) — ` +
        `continuing with the token stored on the job`,
      );
      validUntil = now() + retryMs;
      return token;
    }
  }

  return {
    async get() {
      if (token && now() < validUntil) return token;
      if (!inFlight) {
        inFlight = resolve().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    invalidate() {
      validUntil = 0;
    },
    /** True once a live token has been resolved — used only for logging. */
    get didRefresh() { return refreshed; },
  };
}
