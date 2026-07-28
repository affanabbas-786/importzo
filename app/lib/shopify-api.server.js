// ═══════════════════════════════════════════════════════════════════
// Shared Shopify Admin API request helpers.
//
// Single source of truth for 429 rate-limit backoff and GraphQL
// cost-extension throttle awareness. Previously this logic was
// duplicated (and drifting) across migration-worker.server.js,
// app.transfer.jsx, and app.export.jsx.
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_MAX_RETRIES = 5;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Factory so tests can inject a fake `sleep` (no real waiting) and a
// low `maxRetries`. Production code uses the default singleton below.
export function createShopifyApi({ maxRetries = DEFAULT_MAX_RETRIES, sleep = defaultSleep } = {}) {
  // Fetch wrapper: retries on HTTP 429 honoring Retry-After, otherwise
  // exponential backoff. `timeoutMs`, if provided, bounds each individual
  // attempt via AbortController (not the whole retry sequence).
  async function shopifyFetch(url, { timeoutMs, ...opts } = {}) {
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

  // GraphQL Admin API call. Retries via shopifyFetch, then pre-emptively
  // slows down based on the cost-extension throttle bucket so the *next*
  // call is less likely to 429 at all.
  async function shopifyGraphql(shop, token, query, variables = {}, version, fetchOpts = {}) {
    const res = await shopifyFetch(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      ...fetchOpts,
    });
    const text = await res.text().catch(() => "");
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    const throttle = json?.extensions?.cost?.throttleStatus;
    if (throttle) {
      const { currentlyAvailable, restoreRate, requestedQueryCost } = throttle;
      if (currentlyAvailable < (requestedQueryCost || 0)) {
        const waitMs = Math.min(
          ((requestedQueryCost - currentlyAvailable) / Math.max(restoreRate, 1)) * 1000 + 200,
          8000,
        );
        console.log(`[shopify-api] throttle: waiting ${waitMs}ms (available=${currentlyAvailable}, rate=${restoreRate}/s)`);
        await sleep(waitMs);
      }
    }

    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (json?.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
    return json?.data || {};
  }

  return { shopifyFetch, shopifyGraphql };
}

export const { shopifyFetch, shopifyGraphql } = createShopifyApi();
