// ═══════════════════════════════════════════════════════════════════
// Phase 3 — Rate limiting / abuse protection on the app's OWN endpoints.
//
// The PRD frames this as "prevent one shop's runaway job from starving
// others on shared VPS", which needs two different controls, because they
// stop two different things:
//
//   • A rate limit (requests per window) stops a client hammering an
//     endpoint in a loop.
//   • A concurrency cap stops a small number of simultaneous but very
//     expensive operations. Rate limiting alone doesn't help here: three
//     full-store backups started three seconds apart are only 3 requests,
//     but they'll saturate the box.
//
// Buckets are keyed per shop, so one merchant can never consume another's
// allowance — that's the "starving others" part.
//
// Storage is in-process. That's a deliberate, documented limitation: with
// multiple PM2 workers each holds its own counters, so effective limits are
// per-worker. The alternative (Redis/DB-backed counters) is real
// infrastructure, and an in-process limiter still stops the runaway-loop
// and thundering-herd cases this is for. Noted in PROGRESS.md.
// ═══════════════════════════════════════════════════════════════════

// Fixed-window counters. A sliding window is more precise at the boundary,
// but fixed windows are cheap and predictable, and the goal here is
// stopping abuse rather than exact fairness accounting.
const buckets = new Map(); // key → { count, resetAt }
const running = new Map(); // key → active operation count

// Windows are per shop, per named limit.
export function bucketKey(limitName, shop) {
  return `${limitName}:${shop || "(unknown)"}`;
}

/**
 * Fixed-window rate limit check. Returns
 * { allowed, remaining, limit, resetAt, retryAfterSeconds }.
 * Does not throw — callers decide how to respond.
 */
export function checkRateLimit({ limitName, shop, limit, windowMs, now = Date.now() }) {
  const key = bucketKey(limitName, shop);
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, limit, resetAt, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      limit,
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count, limit, resetAt: bucket.resetAt, retryAfterSeconds: 0 };
}

/** Current concurrent-operation count for a shop. */
export function currentConcurrency(limitName, shop) {
  return running.get(bucketKey(limitName, shop)) || 0;
}

/**
 * Reserves a concurrency slot. Returns a release function, or null when the
 * cap is already reached. The release function is idempotent — double
 * release would otherwise let a shop leak slots and exceed the cap.
 */
export function acquireSlot({ limitName, shop, maxConcurrent }) {
  const key = bucketKey(limitName, shop);
  const active = running.get(key) || 0;
  if (active >= maxConcurrent) return null;

  running.set(key, active + 1);
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const current = running.get(key) || 0;
    if (current <= 1) running.delete(key);
    else running.set(key, current - 1);
  };
}

// Named policies. Expensive, store-wide operations get tight caps; cheap
// reads get generous ones.
export const POLICIES = Object.freeze({
  // Full-store snapshot: paginates the entire destination catalog.
  backup: { limit: 10, windowMs: 60 * 60 * 1000, maxConcurrent: 1 },
  // Writes back over every product in a snapshot.
  restore: { limit: 5, windowMs: 60 * 60 * 1000, maxConcurrent: 1 },
  // Deletes products. Rare and deliberate by nature.
  rollback: { limit: 10, windowMs: 60 * 60 * 1000, maxConcurrent: 1 },
  // Reads both stores in full; expensive but non-mutating.
  preview: { limit: 30, windowMs: 60 * 60 * 1000, maxConcurrent: 2 },
  // Cheap CRUD.
  scheduleAdmin: { limit: 120, windowMs: 60 * 60 * 1000, maxConcurrent: 10 },
  // Starting a migration is the single most expensive thing the app does.
  migrationJob: { limit: 20, windowMs: 60 * 60 * 1000, maxConcurrent: 2 },
  // Theme transfer. maxConcurrent 1, stricter than migrationJob's 2: a theme
  // job holds a staging directory of the whole theme and saturates the shop's
  // REST bucket for its duration, so two at once on one shop is never useful.
  themeJob: { limit: 10, windowMs: 60 * 60 * 1000, maxConcurrent: 1 },
  // Cheap CRUD — saved field-mapping templates (Phase 4).
  mappingTemplate: { limit: 120, windowMs: 60 * 60 * 1000, maxConcurrent: 10 },
  // AI SEO suggestions (Phase 4.4) — calls a third-party LLM on the
  // merchant's own key. Capped mainly to stop a runaway client-side loop
  // from silently burning through their API budget, not to protect our
  // own infra (the cost lands on the merchant's account, not ours).
  aiEnhance: { limit: 60, windowMs: 60 * 60 * 1000, maxConcurrent: 3 },
});

function tooManyRequests(body, retryAfterSeconds) {
  return Response.json(body, {
    status: 429,
    headers: {
      "Retry-After": String(retryAfterSeconds),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Applies a named policy for a shop.
 *
 * Returns { ok: true, release } when the caller may proceed — `release`
 * MUST be called in a finally block, or the shop leaks a concurrency slot.
 * Returns { ok: false, response } with a ready-to-return 429 otherwise.
 */
export function enforcePolicy({ policyName, shop, now = Date.now() }) {
  const policy = POLICIES[policyName];
  if (!policy) throw new Error(`rate-limit: unknown policy "${policyName}"`);

  const rate = checkRateLimit({
    limitName: policyName, shop, limit: policy.limit, windowMs: policy.windowMs, now,
  });

  if (!rate.allowed) {
    return {
      ok: false,
      response: tooManyRequests({
        ok: false,
        error: `Rate limit exceeded for this operation. Try again in ${rate.retryAfterSeconds}s.`,
        limit: rate.limit,
        retryAfterSeconds: rate.retryAfterSeconds,
      }, rate.retryAfterSeconds),
    };
  }

  const release = acquireSlot({ limitName: policyName, shop, maxConcurrent: policy.maxConcurrent });
  if (!release) {
    return {
      ok: false,
      response: tooManyRequests({
        ok: false,
        error: `Another ${policyName} operation is already running for this store. Wait for it to finish.`,
        maxConcurrent: policy.maxConcurrent,
        retryAfterSeconds: 30,
      }, 30),
    };
  }

  return { ok: true, release, remaining: rate.remaining };
}

/**
 * Convenience wrapper: enforces a policy around an async handler and always
 * releases the slot, including when the handler throws.
 */
export async function withPolicy({ policyName, shop, now = Date.now() }, handler) {
  const gate = enforcePolicy({ policyName, shop, now });
  if (!gate.ok) return gate.response;
  try {
    return await handler();
  } finally {
    gate.release();
  }
}

// Test-only: clears all counters between cases.
export function __resetRateLimitState() {
  buckets.clear();
  running.clear();
}
