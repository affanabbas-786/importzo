// ═══════════════════════════════════════════════════════════════════
// Shared Shopify Admin API request helpers.
//
// Single source of truth for 429 rate-limit backoff and GraphQL
// cost-extension throttle awareness. Previously this logic was
// duplicated (and drifting) across migration-worker.server.js,
// app.transfer.jsx, and app.export.jsx.
//
// THREE separate mechanisms defend against rate limits here, because
// Shopify signals exhaustion in three different ways and each of the
// three needs a different response:
//
//   1. HTTP 429 — the REST-style refusal. Honour Retry-After.
//      (shopifyFetch, unchanged.)
//   2. A GraphQL THROTTLED error — HTTP *200* with an `errors` array.
//      This is how the Admin GraphQL API reports a query it refused to
//      run. It is NOT a 429 and never reaches the 429 path above.
//   3. extensions.cost.throttleStatus — the leaky bucket's live state,
//      returned on every successful call. Used to slow down BEFORE
//      being refused.
//
// (2) is the one that was missing, and it was the expensive gap: a
// THROTTLED response fell through to the generic `json.errors` throw and
// was reported to the merchant as a permanent per-item failure. A single
// transfer run failed 683 of 5061 items that way — every one of them
// retryable, none of them retried.
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_MAX_RETRIES = 5;

// Retries specifically for a GraphQL THROTTLED refusal, on top of the
// 429 retries in shopifyFetch. Delays are 1s, 2s, 4s.
const DEFAULT_THROTTLE_RETRIES = 3;

// Parallel in-flight GraphQL calls allowed per shop. Shopify's GraphQL
// limit is a per-shop cost bucket, so the cap belongs per shop rather
// than per process: two shops transferring at once do not share a bucket
// and must not throttle each other.
//
// 2 rather than the 5–10 the callers used to fire: the transfer engine's
// batches (Promise.all over 10 products, each of which issues several
// mutations) could otherwise put 30+ concurrent mutations against one
// bucket, which drains it faster than any backoff can recover it.
const DEFAULT_CONCURRENCY = 2;

// Same idea for REST, but a SEPARATE budget: Shopify meters REST and
// GraphQL against two independent buckets, so sharing one semaphore
// between them would make a theme's asset downloads needlessly block an
// unrelated product mutation (and vice versa).
const DEFAULT_REST_CONCURRENCY = 2;

// REST returns `X-Shopify-Shop-Api-Call-Limit: used/total` on EVERY
// response — the leaky bucket's live state, exactly analogous to the
// cost extension on GraphQL, and until now completely ignored.
//
// Shopify sizes the bucket at 20x the per-second leak rate across every
// tier (40→2/s Basic, 80→4/s Advanced, 400→20/s Plus), so the total tells
// us the shop's actual rate. Deriving it means this paces correctly on a
// Plus store instead of crawling at a hardcoded 2/s.
const REST_BUCKET_TO_LEAK_RATIO = 20;

// Fraction of the bucket to keep free. Pacing starts once usage crosses
// this, so the bucket is refilled steadily rather than being drained to
// empty and then hammered into 429s.
const REST_HEADROOM = 0.1;

// Absolute floor on free slots, independent of the percentage above. With
// restConcurrency=2 there can be 2 calls in flight, so anything less than a
// few free slots races into a 429 no matter what the fraction says.
const REST_MIN_FREE_SLOTS = 4;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal async semaphore — `limit` concurrent holders, FIFO waiters.
 *
 * Deliberately hand-rolled rather than pulling in p-queue: this needs ~15
 * lines, runs in the request path of a production app, and adding a
 * dependency to the server bundle for it is a worse trade. The contract is
 * the part that matters — acquire() resolves when a slot is free, and the
 * returned release() must be called exactly once, from a `finally`.
 */
export function createSemaphore(limit) {
  let active = 0;
  const waiters = [];

  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  async function acquire() {
    if (active < limit) {
      active += 1;
      return release;
    }
    await new Promise((resolve) => waiters.push(resolve));
    return release;
  }

  return { acquire, get active() { return active; }, get queued() { return waiters.length; } };
}

/**
 * True when a GraphQL response is Shopify refusing the query for rate-limit
 * reasons rather than for anything the caller can fix by changing the query.
 *
 * Matches on the documented `extensions.code` first, and falls back to the
 * message text: the code is absent on some older/edge responses, and treating
 * a throttle as a permanent failure is far more costly than one extra retry
 * of a genuinely broken query.
 */
export function isThrottledResponse(json) {
  const errors = json?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.some((e) => {
    const code = e?.extensions?.code;
    if (typeof code === "string" && code.toUpperCase() === "THROTTLED") return true;
    return /throttled|exceeded .*rate limit/i.test(String(e?.message || ""));
  });
}

/**
 * Parses `X-Shopify-Shop-Api-Call-Limit` ("32/40") into { used, total }.
 * Returns null for a missing or malformed header — callers then simply
 * don't pace, which is the pre-existing behaviour.
 */
export function parseCallLimitHeader(value) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(value ?? ""));
  if (!m) return null;
  const used = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return { used, total };
}

/**
 * How long to pause after a REST call, given the bucket state it reported.
 *
 * Returns 0 while there is comfortable headroom, then scales up as the
 * bucket fills — enough time for the leak to restore the headroom we want
 * back. Capped at 5s so one anomalous reading can't stall a transfer.
 *
 * This is what turns blind bursting into feedback-driven pacing. The old
 * behaviour fired 8 concurrent asset reads, drove the bucket to empty,
 * took a 429, and slept a flat 2000ms — which on a 2/s tier overshoots the
 * 500ms actually needed by 4x, so the retries themselves were a large part
 * of the wall time.
 */
export function restWaitMs(limit, headroom = REST_HEADROOM) {
  if (!limit) return 0;
  const { used, total } = limit;
  const leakPerSec = Math.max(total / REST_BUCKET_TO_LEAK_RATIO, 1);
  // Always keep at least MIN_FREE_SLOTS free regardless of the fraction, so
  // a small bucket still has room for the in-flight calls the semaphore
  // permits — a percentage alone rounds to nothing on a 40-slot bucket.
  const wantFree = Math.max(total * headroom, REST_MIN_FREE_SLOTS);
  const free = total - used;
  if (free >= wantFree) return 0;
  return Math.min(((wantFree - free) / leakPerSec) * 1000, 5000);
}

/**
 * The per-shop key to rate-limit a REST URL under, or null if this URL is
 * not a Shopify Admin REST call and must not be limited at all.
 *
 * The `/admin/api/` check matters: shopifyFetch is also used for CDN asset
 * downloads (cdn.shopify.com), which are static file reads against no
 * bucket whatsoever. Queueing those behind the Admin limiter would slow
 * theme transfers down for nothing.
 */
export function restLimitKey(url) {
  try {
    const u = new URL(String(url));
    if (!u.pathname.includes("/admin/api/")) return null;
    return u.host;
  } catch {
    return null;
  }
}

/**
 * Builds the `query:` search term for an exact handle lookup.
 *
 * The quoting is the whole point and it is not cosmetic. Shopify's search
 * syntax treats `-` as a token separator, and a LEADING `-` as negation, so
 * an unquoted `handle:your-privacy-choices` does not search for that handle —
 * it parses as "your" AND NOT "privacy" AND NOT "choices" and matches
 * nothing. Single-word handles ("contact", "news") contain no hyphen and
 * worked fine, which is why this looked like an intermittent bug rather than
 * a total failure for every hyphenated handle.
 *
 * That mattered most for products, whose handles are hyphenated almost by
 * definition ("blue-cotton-shirt"): conflict detection was silently finding
 * nothing, so conflictMode "skip"/"overwrite" both behaved as "create".
 *
 * Embedded double quotes are stripped rather than escaped — a Shopify handle
 * can never contain one, so anything that does is malformed input, and
 * dropping it keeps the query syntactically valid instead of unbalanced.
 */
export function handleSearchQuery(handle) {
  const safe = String(handle ?? "").replace(/"/g, "");
  return `handle:"${safe}"`;
}

// Factory so tests can inject a fake `sleep` (no real waiting), a low
// `maxRetries`, and a custom concurrency. Production code uses the default
// singleton below.
export function createShopifyApi({
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = defaultSleep,
  throttleRetries = DEFAULT_THROTTLE_RETRIES,
  concurrency = DEFAULT_CONCURRENCY,
  restConcurrency = DEFAULT_REST_CONCURRENCY,
  restHeadroom = REST_HEADROOM,
} = {}) {
  // One semaphore per shop domain, per bucket — see DEFAULT_CONCURRENCY.
  // "gql" and "rest" are kept apart because Shopify meters them separately.
  const limiters = new Map();
  function limiterFor(kind, shop) {
    const key = `${kind}:${String(shop || "unknown")}`;
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = createSemaphore(kind === "rest" ? restConcurrency : concurrency);
      limiters.set(key, limiter);
    }
    return limiter;
  }

  // Raw fetch + 429 retry, with NO concurrency limiting of its own.
  //
  // Split out from shopifyFetch deliberately. shopifyGraphql needs the retry
  // behaviour but must NOT also take a REST permit: it already holds a
  // GraphQL permit, and acquiring a second permit from a different pool
  // while holding the first couples two independent rate buckets together —
  // GraphQL work would queue behind theme asset downloads for no reason.
  // Routing GraphQL here instead of through shopifyFetch keeps the two
  // budgets genuinely independent and avoids the nested acquire entirely.
  async function fetchWithRetry(url, { timeoutMs, ...opts } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      if (timeoutMs) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          res = await fetch(url, { ...opts, signal: ctrl.signal });
        } finally {
          clearTimeout(t);
        }
      } else {
        res = await fetch(url, opts);
      }

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get("Retry-After") || "0");
        const delay = Math.max(retryAfter * 1000, 1000 * Math.pow(2, attempt));
        if (attempt < maxRetries) {
          console.log(`[shopify-api] 429 — ${url.split("?")[0]} — attempt ${attempt + 1}/${maxRetries}, waiting ${delay}ms`);
          await sleep(delay);
          continue;
        }
      }
      return res;
    }
    return fetch(url, opts);
  }

  // Public REST helper: concurrency-capped per shop, then paced from the
  // bucket state the response reports. The pause happens while still
  // holding the permit — that is what makes it pacing rather than just a
  // concurrency cap, since a semaphore alone limits how many calls run at
  // once but not how fast they are issued.
  async function shopifyFetch(url, opts = {}) {
    const key = restLimitKey(url);
    if (!key) return fetchWithRetry(url, opts); // not an Admin REST call — see restLimitKey
    const release = await limiterFor("rest", key).acquire();
    try {
      const res = await fetchWithRetry(url, opts);
      const waitMs = restWaitMs(parseCallLimitHeader(res.headers?.get?.("X-Shopify-Shop-Api-Call-Limit")), restHeadroom);
      if (waitMs > 0) await sleep(waitMs);
      return res;
    } finally {
      release();
    }
  }

  // How long to hold off before the next call, given the bucket state
  // Shopify just reported. Returns 0 when there is nothing to wait for.
  //
  // Two independent triggers:
  //   - the next call of this size would not fit in what's left, or
  //   - the bucket is under one second's worth of restore, i.e. close
  //     enough to empty that any concurrent call would tip it over.
  // Capped at 8s so a pathological reading can't stall a transfer.
  function throttleWaitMs(throttle) {
    if (!throttle) return 0;
    const { currentlyAvailable, restoreRate, requestedQueryCost } = throttle;
    if (typeof currentlyAvailable !== "number") return 0;
    const rate = Math.max(restoreRate || 0, 1);
    const cost = requestedQueryCost || 0;

    if (currentlyAvailable < cost) {
      return Math.min(((cost - currentlyAvailable) / rate) * 1000 + 200, 8000);
    }
    if (currentlyAvailable < rate) {
      // Under a second of headroom — let the bucket refill a little.
      return Math.min(((rate - currentlyAvailable) / rate) * 1000 + 200, 8000);
    }
    return 0;
  }

  // GraphQL Admin API call. Retries via shopifyFetch (429), retries again on
  // a GraphQL THROTTLED refusal, then pre-emptively slows down based on the
  // cost-extension throttle bucket so the *next* call is less likely to be
  // refused at all. Concurrency per shop is capped by the semaphore above.
  async function shopifyGraphql(shop, token, query, variables = {}, version, fetchOpts = {}) {
    const release = await limiterFor("gql", shop).acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetchWithRetry(`https://${shop}/admin/api/${version}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({ query, variables }),
          ...fetchOpts,
        });
        const text = await res.text().catch(() => "");
        let json;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }

        // Shopify refused the query for rate-limit reasons. This arrives as
        // HTTP 200 with an `errors` array, so it must be handled before the
        // generic error throw below — otherwise it reads as permanent.
        if (isThrottledResponse(json)) {
          if (attempt < throttleRetries) {
            // Prefer the bucket's own arithmetic when Shopify sent it;
            // fall back to 1s/2s/4s when it didn't.
            const suggested = throttleWaitMs(json?.extensions?.cost?.throttleStatus);
            const delay = Math.max(suggested, 1000 * Math.pow(2, attempt));
            console.log(`[shopify-api] THROTTLED — ${shop} — attempt ${attempt + 1}/${throttleRetries}, waiting ${delay}ms`);
            await sleep(delay);
            continue;
          }
          console.warn(`[shopify-api] THROTTLED — ${shop} — giving up after ${throttleRetries} retries`);
          throw new Error(
            `Shopify rate limit (THROTTLED) — still refused after ${throttleRetries} retries. This item can be retried.`,
          );
        }

        const waitMs = throttleWaitMs(json?.extensions?.cost?.throttleStatus);
        if (waitMs > 0) {
          const t = json.extensions.cost.throttleStatus;
          console.log(`[shopify-api] throttle: waiting ${waitMs}ms (available=${t.currentlyAvailable}, rate=${t.restoreRate}/s)`);
          await sleep(waitMs);
        }

        if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (json?.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
        return json?.data || {};
      }
    } finally {
      release();
    }
  }

  return { shopifyFetch, shopifyGraphql };
}

export const { shopifyFetch, shopifyGraphql } = createShopifyApi();
