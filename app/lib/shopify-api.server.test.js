import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShopifyApi, createSemaphore, isThrottledResponse, handleSearchQuery, parseCallLimitHeader, restWaitMs, restLimitKey } from "./shopify-api.server.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("shopifyFetch", () => {
  let fetchMock;
  let sleep;
  let api;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    sleep = vi.fn().mockResolvedValue(undefined);
    api = createShopifyApi({ maxRetries: 3, sleep });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the response immediately on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on 429 honoring Retry-After header, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000); // Retry-After: 2s beats the 1s exponential floor
  });

  it("falls back to exponential backoff when Retry-After is absent", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(200);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]); // 1000*2^0, 1000*2^1
  });

  it("gives up after maxRetries and returns the final 429 response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(429);
    // 1 initial + 3 retries = 4 calls, sleeping between each retry (3 sleeps)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-429 error statuses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds each attempt with an AbortController when timeoutMs is set", async () => {
    fetchMock.mockImplementationOnce((url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    await api.shopifyFetch("https://shop.example/x", { timeoutMs: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies a default AbortController even when the caller passes no timeoutMs at all", async () => {
    // api came from beforeEach with no timeoutMs override — production default applies.
    fetchMock.mockImplementationOnce((url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    await api.shopifyFetch("https://shop.example/x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opts out of the default timeout when timeoutMs: 0 is passed explicitly", async () => {
    fetchMock.mockImplementationOnce((url, opts) => {
      expect(opts.signal).toBeUndefined();
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    await api.shopifyFetch("https://shop.example/x", { timeoutMs: 0 });
  });
});

// The 2026-09-01 incident: a transfer request's outbound Shopify call
// stalled with no response and no thrown error, so the whole HTTP request
// (and the merchant-facing connection) hung until nginx's own timeout fired
// a 504 roughly 15 minutes later. `fetchWithRetry` previously let a thrown
// fetch error (including our own AbortError) escape uncaught, bypassing the
// retry loop entirely — these tests pin the fix: a hung call aborts at the
// configured timeout AND is retried with the same backoff a 429 gets.
describe("shopifyFetch — timeout handling", () => {
  let sleep;

  beforeEach(() => {
    sleep = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // A fetch mock that never resolves on its own — only settles when its
  // AbortSignal fires, exactly like a real hung network call under undici.
  function hangingFetch() {
    return vi.fn((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));
  }

  it("aborts a hung request at the configured timeout and retries with 429-style backoff", async () => {
    const fetchMock = hangingFetch();
    global.fetch = fetchMock;
    const api = createShopifyApi({ sleep, maxRetries: 2, timeoutMs: 30 });

    await expect(api.shopifyFetch("https://shop.example/x")).rejects.toThrow(/timed out after 30ms/);

    // 1 initial + 2 retries = 3 attempts, each one aborted at 30ms.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Same exponential ladder as 429 handling: 1000ms, 2000ms.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("succeeds once a retry after a timeout gets a real response", async () => {
    let call = 0;
    global.fetch = vi.fn((url, opts) => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    const api = createShopifyApi({ sleep, maxRetries: 2, timeoutMs: 30 });

    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("does not retry-storm: a genuinely dead upstream still gives up after maxRetries with a clear error", async () => {
    const fetchMock = hangingFetch();
    global.fetch = fetchMock;
    const api = createShopifyApi({ sleep, maxRetries: 5, timeoutMs: 30 });

    await expect(api.shopifyFetch("https://shop.example/x")).rejects.toThrow(/gave up after 5 retries/);

    expect(fetchMock).toHaveBeenCalledTimes(6); // 1 initial + 5 retries, not unbounded
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("retries a plain network failure (not just our own timeout abort) the same way", async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = createShopifyApi({ sleep, maxRetries: 2, timeoutMs: 30 });

    const res = await api.shopifyFetch("https://shop.example/x");
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-timeout error's own message after exhausting retries, rather than a generic one", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const api = createShopifyApi({ sleep, maxRetries: 1, timeoutMs: 30 });

    await expect(api.shopifyFetch("https://shop.example/x")).rejects.toThrow(/ECONNRESET/);
  });

  it("retries a hung shopifyGraphql call the same way as a hung REST call", async () => {
    const fetchMock = hangingFetch();
    global.fetch = fetchMock;
    const api = createShopifyApi({ sleep, maxRetries: 1, timeoutMs: 30 });

    await expect(
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
    ).rejects.toThrow(/timed out after 30ms/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it("uses the production default of 30000ms when no override is configured anywhere", async () => {
    vi.useFakeTimers();
    // maxRetries: 0 isolates the assertion to the timeout value itself,
    // independent of the retry ladder covered by the tests above.
    const api = createShopifyApi({ sleep, maxRetries: 0 });
    global.fetch = vi.fn((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));

    const pending = expect(api.shopifyFetch("https://shop.example/x")).rejects.toThrow(/timed out after 30000ms/);
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
  });
});

describe("shopifyGraphql", () => {
  let fetchMock;
  let sleep;
  let api;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    sleep = vi.fn().mockResolvedValue(undefined);
    api = createShopifyApi({ maxRetries: 3, sleep });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns data on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { shop: { name: "Test" } } }));
    const data = await api.shopifyGraphql("shop.myshopify.com", "tok", "{ shop { name } }", {}, "2025-10");
    expect(data).toEqual({ shop: { name: "Test" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://shop.myshopify.com/admin/api/2025-10/graphql.json",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-ok HTTP response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    await expect(
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ shop { name } }", {}, "2025-10"),
    ).rejects.toThrow(/GraphQL HTTP 500/);
  });

  it("throws on GraphQL errors array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: "field not found" }] }));
    await expect(
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ bogus }", {}, "2025-10"),
    ).rejects.toThrow(/field not found/);
  });

  it("retries on 429 before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const data = await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10");
    expect(data).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("pre-emptively waits when the cost throttle bucket is nearly empty", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { ok: true },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 10, restoreRate: 50, requestedQueryCost: 100 } } },
    }));
    await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10");
    expect(sleep).toHaveBeenCalledTimes(1);
    // (100 - 10) / 50 * 1000 + 200 = 2000ms
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not wait when the throttle bucket has plenty of room", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { ok: true },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 900, restoreRate: 50, requestedQueryCost: 10 } } },
    }));
    await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10");
    expect(sleep).not.toHaveBeenCalled();
  });

  // ── GraphQL THROTTLED: HTTP 200 + errors[], NOT a 429 ──
  // The gap that made 683 of 5061 items in one run fail permanently.
  const THROTTLED_BODY = {
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50, requestedQueryCost: 10 } } },
  };

  it("retries a GraphQL THROTTLED refusal and returns data once it succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(THROTTLED_BODY))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const data = await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10");
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially across repeated THROTTLED refusals", async () => {
    // No throttleStatus, so the 1s/2s/4s fallback ladder is what's used.
    const bare = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(bare))
      .mockResolvedValueOnce(jsonResponse(bare))
      .mockResolvedValueOnce(jsonResponse(bare))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const data = await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10");
    expect(data).toEqual({ ok: true });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it("gives up after the throttle retry budget with a retryable-sounding error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(THROTTLED_BODY));
    await expect(
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
    ).rejects.toThrow(/THROTTLED.*can be retried/s);
    // 1 initial + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recognises a THROTTLED response that carries no extensions.code", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Throttled" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    await expect(
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
    ).resolves.toEqual({ ok: true });
  });

  // The counterpart to the retry: a genuine query bug must still fail fast,
  // not burn four attempts and 7 seconds before reporting itself.
  it("does not retry a non-throttle GraphQL error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: "field not found" }] }));
    await expect(
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ bogus }", {}, "2025-10"),
    ).rejects.toThrow(/field not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits when the bucket is under one second of restore, even with no cost deficit", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { ok: true },
      extensions: { cost: { throttleStatus: { currentlyAvailable: 10, restoreRate: 50, requestedQueryCost: 5 } } },
    }));
    await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10");
    // (50 - 10) / 50 * 1000 + 200 = 1000ms
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("forwards extra fetchOpts (e.g. timeoutMs, signal) to the underlying request", async () => {
    fetchMock.mockImplementationOnce((url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(jsonResponse({ data: { ok: true } }));
    });
    await api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10", { timeoutMs: 30000 });
  });
});

describe("default singleton export", () => {
  it("exposes shopifyFetch and shopifyGraphql with production defaults", async () => {
    const mod = await import("./shopify-api.server.js");
    expect(typeof mod.shopifyFetch).toBe("function");
    expect(typeof mod.shopifyGraphql).toBe("function");
  });
});

describe("per-shop concurrency limiter", () => {
  let sleep;

  beforeEach(() => {
    sleep = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  // Deferred-response fetch so we can observe how many calls are in flight
  // at once rather than inferring it from timing.
  function deferredFetch() {
    const pending = [];
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      pending.push(() => resolve(jsonResponse({ data: { ok: true } })));
    }));
    return { fetchMock, pending };
  }

  // Measures the peak number of simultaneously in-flight fetches rather than
  // asserting call counts at hand-counted microtask ticks — the observable
  // property that actually matters, and one that doesn't depend on how many
  // promise hops the semaphore happens to take internally.
  it("never runs more than `concurrency` GraphQL calls against one shop at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    global.fetch = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return jsonResponse({ data: { ok: true } });
    });
    const api = createShopifyApi({ sleep, concurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () =>
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10")));

    expect(peak).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(8); // all 8 ran, just not at once
  });

  it("serialises fully at concurrency 1", async () => {
    let inFlight = 0;
    let peak = 0;
    global.fetch = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return jsonResponse({ data: { ok: true } });
    });
    const api = createShopifyApi({ sleep, concurrency: 1 });

    await Promise.all(Array.from({ length: 5 }, () =>
      api.shopifyGraphql("shop.myshopify.com", "tok", "{ ok }", {}, "2025-10")));

    expect(peak).toBe(1);
  });

  // Shopify's GraphQL cost bucket is per shop, so two shops transferring
  // concurrently must not queue behind each other.
  it("gives each shop its own independent budget", async () => {
    const { fetchMock, pending } = deferredFetch();
    global.fetch = fetchMock;
    const api = createShopifyApi({ sleep, concurrency: 2 });

    const calls = [
      api.shopifyGraphql("a.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
      api.shopifyGraphql("a.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
      api.shopifyGraphql("b.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
      api.shopifyGraphql("b.myshopify.com", "tok", "{ ok }", {}, "2025-10"),
    ];

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 per shop, not 2 overall

    while (pending.length) pending.shift()();
    await Promise.all(calls);
  });

  // A throw must not leak a permit, or the transfer deadlocks after
  // `concurrency` failures — a far worse outcome than the original bug.
  it("releases its slot when a call throws", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "boom" }] }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "boom" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const api = createShopifyApi({ sleep, concurrency: 2 });

    await expect(api.shopifyGraphql("s.myshopify.com", "t", "{ x }", {}, "v")).rejects.toThrow(/boom/);
    await expect(api.shopifyGraphql("s.myshopify.com", "t", "{ x }", {}, "v")).rejects.toThrow(/boom/);
    // If permits leaked, both slots are now gone and this would hang forever.
    await expect(api.shopifyGraphql("s.myshopify.com", "t", "{ x }", {}, "v")).resolves.toEqual({ ok: true });
  });
});

describe("createSemaphore", () => {
  it("admits up to the limit, then queues in FIFO order", async () => {
    const sem = createSemaphore(2);
    const order = [];

    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.active).toBe(2);

    const third = sem.acquire().then((r) => { order.push("third"); return r; });
    const fourth = sem.acquire().then((r) => { order.push("fourth"); return r; });
    expect(sem.queued).toBe(2);

    r1();
    (await third)();
    r2();
    await fourth;
    expect(order).toEqual(["third", "fourth"]);
  });
});

describe("handleSearchQuery", () => {
  // The bug: an unquoted hyphenated handle is parsed by Shopify's search as
  // token negation, matching nothing. Single-word handles were unaffected,
  // which is why only SOME pages/products deduped.
  it("quotes the handle so hyphens are not read as token separators", () => {
    expect(handleSearchQuery("your-privacy-choices")).toBe('handle:"your-privacy-choices"');
    expect(handleSearchQuery("blue-cotton-shirt")).toBe('handle:"blue-cotton-shirt"');
  });

  it("quotes single-word handles identically — one code path, not two", () => {
    expect(handleSearchQuery("contact")).toBe('handle:"contact"');
  });

  it("strips embedded double quotes rather than emitting an unbalanced query", () => {
    expect(handleSearchQuery('we"ird')).toBe('handle:"weird"');
  });

  it("produces a syntactically valid query for empty or nullish input", () => {
    expect(handleSearchQuery("")).toBe('handle:""');
    expect(handleSearchQuery(null)).toBe('handle:""');
    expect(handleSearchQuery(undefined)).toBe('handle:""');
  });
});

describe("isThrottledResponse", () => {
  it("recognises the documented extensions.code", () => {
    expect(isThrottledResponse({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] })).toBe(true);
  });

  it("recognises a lowercase/mixed-case code", () => {
    expect(isThrottledResponse({ errors: [{ message: "x", extensions: { code: "throttled" } }] })).toBe(true);
  });

  // Some responses carry no extensions.code; treating those as permanent is
  // the expensive direction, so the message is a deliberate fallback.
  it("falls back to the message when no code is present", () => {
    expect(isThrottledResponse({ errors: [{ message: "Throttled" }] })).toBe(true);
    expect(isThrottledResponse({ errors: [{ message: "Exceeded 2 calls per second rate limit" }] })).toBe(true);
  });

  it("does not fire on ordinary GraphQL errors", () => {
    expect(isThrottledResponse({ errors: [{ message: "Field 'job' doesn't exist" }] })).toBe(false);
  });

  it("is false for a successful or empty response", () => {
    expect(isThrottledResponse({ data: { ok: true } })).toBe(false);
    expect(isThrottledResponse({ errors: [] })).toBe(false);
    expect(isThrottledResponse(null)).toBe(false);
  });
});

describe("parseCallLimitHeader", () => {
  it("parses the documented used/total form", () => {
    expect(parseCallLimitHeader("32/40")).toEqual({ used: 32, total: 40 });
    expect(parseCallLimitHeader(" 5 / 400 ")).toEqual({ used: 5, total: 400 });
  });

  it("returns null for missing or malformed values, so callers just don't pace", () => {
    for (const v of [null, undefined, "", "abc", "40", "x/40", "32/0", "32/abc"]) {
      expect(parseCallLimitHeader(v)).toBeNull();
    }
  });
});

describe("restWaitMs — bucket-feedback pacing", () => {
  // Headroom is deliberately small (10%, floor of 4 slots). A larger margin
  // was measured against a leaky-bucket simulator and cost ~16% wall time on
  // a Basic-tier bucket for no extra safety: 10% already yields zero 429s,
  // and burning the burst capacity is most of why the transfer keeps up at
  // all on a 2/s tier.
  it("does not pace while there is comfortable headroom", () => {
    expect(restWaitMs({ used: 0, total: 40 })).toBe(0);
    expect(restWaitMs({ used: 20, total: 40 })).toBe(0);
    expect(restWaitMs({ used: 36, total: 40 })).toBe(0); // exactly at the 4-slot floor
  });

  it("paces once the bucket crosses the headroom threshold", () => {
    // 40-bucket => 2/s leak, want 4 free, have 2 => (4-2)/2*1000 = 1000ms
    expect(restWaitMs({ used: 38, total: 40 })).toBe(1000);
    expect(restWaitMs({ used: 40, total: 40 })).toBe(2000);
  });

  it("honours an explicit headroom override", () => {
    // 30% of 40 = 12 wanted free, have 5 => (12-5)/2*1000 = 3500ms
    expect(restWaitMs({ used: 35, total: 40 }, 0.3)).toBe(3500);
  });

  // The self-tuning property. Note it is NOT "a bigger bucket always waits
  // less at the same relative fullness" — wantFree, free and leak all scale
  // with total, so equal *fractions* give an equal wait, by construction.
  //
  // What actually differs is the impact of the same absolute work: 35 calls
  // in flight nearly exhausts a Basic bucket and must be paced, while on
  // Plus it is a rounding error that should not be paced at all. That is
  // what makes a Plus store run at its real speed instead of crawling at a
  // hardcoded 2/s.
  it("derives the leak rate from the bucket size instead of hardcoding 2/s", () => {
    expect(restWaitMs({ used: 38, total: 40 })).toBe(1000); // Basic: pace
    expect(restWaitMs({ used: 38, total: 400 })).toBe(0);   // Plus: a rounding error
  });

  it("waits proportionally less per unit of headroom on a faster-leaking bucket", () => {
    // Same absolute shortfall (20 slots) on each tier: Basic leaks 2/s, Plus 20/s.
    expect(restWaitMs({ used: 400, total: 400 })).toBe(2000); // 40 short / 20 per sec
    expect(restWaitMs({ used: 380, total: 400 })).toBe(1000); // 20 short / 20 per sec
  });

  it("caps the wait so one anomalous reading cannot stall a transfer", () => {
    expect(restWaitMs({ used: 400, total: 400 })).toBeLessThanOrEqual(5000);
    expect(restWaitMs({ used: 40, total: 40 })).toBeLessThanOrEqual(5000);
  });

  it("returns 0 when the header was absent", () => {
    expect(restWaitMs(null)).toBe(0);
  });
});

describe("restLimitKey", () => {
  it("limits Admin REST calls, keyed per shop", () => {
    expect(restLimitKey("https://s.myshopify.com/admin/api/2026-04/themes/1/assets.json")).toBe("s.myshopify.com");
  });

  // CDN downloads are static file reads against no bucket — queueing them
  // behind the Admin limiter would slow theme transfers for nothing.
  it("does NOT limit CDN or other non-Admin URLs", () => {
    expect(restLimitKey("https://cdn.shopify.com/s/files/1/hero.jpg")).toBeNull();
    expect(restLimitKey("https://example.com/anything")).toBeNull();
  });

  it("returns null for a malformed URL rather than throwing", () => {
    expect(restLimitKey("not a url")).toBeNull();
    expect(restLimitKey(null)).toBeNull();
  });
});

describe("shopifyFetch — REST rate limiting", () => {
  let sleep;
  beforeEach(() => { sleep = vi.fn().mockResolvedValue(undefined); });
  afterEach(() => vi.restoreAllMocks());

  const REST_URL = "https://s.myshopify.com/admin/api/2026-04/themes/1/assets.json";

  function limitResponse(used, total) {
    return jsonResponse({ asset: {} }, { headers: { "X-Shopify-Shop-Api-Call-Limit": `${used}/${total}` } });
  }

  it("caps concurrent Admin REST calls per shop", async () => {
    let inFlight = 0, peak = 0;
    global.fetch = vi.fn(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return limitResponse(1, 40);
    });
    const api = createShopifyApi({ sleep, restConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => api.shopifyFetch(REST_URL)));
    expect(peak).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(8);
  });

  it("paces off the call-limit header when the bucket fills", async () => {
    global.fetch = vi.fn(async () => limitResponse(38, 40));
    const api = createShopifyApi({ sleep, restConcurrency: 2 });
    await api.shopifyFetch(REST_URL);
    // want 4 free, have 2 => (4-2)/2*1000 = 1000ms
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("does not pace when the bucket is healthy", async () => {
    global.fetch = vi.fn(async () => limitResponse(2, 40));
    const api = createShopifyApi({ sleep, restConcurrency: 2 });
    await api.shopifyFetch(REST_URL);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("leaves non-Admin URLs unlimited and unpaced", async () => {
    let inFlight = 0, peak = 0;
    global.fetch = vi.fn(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return jsonResponse({});
    });
    const api = createShopifyApi({ sleep, restConcurrency: 2 });

    await Promise.all(Array.from({ length: 6 }, () => api.shopifyFetch("https://cdn.shopify.com/s/files/1/a.png")));
    expect(peak).toBeGreaterThan(2); // CDN reads are not queued behind the Admin limiter
  });

  // Regression guard for the nested-acquire hazard: GraphQL holds a gql
  // permit and must NOT also take a rest permit, or the two independent
  // buckets become coupled (and, with both pools saturated, could stall).
  it("keeps GraphQL independent of the REST budget", async () => {
    let restInFlight = 0, gqlSeen = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("graphql.json")) {
        gqlSeen++;
        return jsonResponse({ data: { ok: true } });
      }
      restInFlight++;
      await new Promise((r) => setTimeout(r, 20));
      restInFlight--;
      return limitResponse(1, 40);
    });
    const api = createShopifyApi({ sleep, concurrency: 2, restConcurrency: 2 });

    // Saturate the REST pool, then fire GraphQL — it must not wait on REST.
    const rest = Array.from({ length: 4 }, () => api.shopifyFetch(REST_URL));
    const gql = Array.from({ length: 2 }, () => api.shopifyGraphql("s.myshopify.com", "t", "{ok}", {}, "2026-04"));
    await Promise.all(gql);

    expect(gqlSeen).toBe(2); // completed without waiting for the REST queue to drain
    // ...and REST was genuinely still busy at that moment, so this proves
    // independence rather than just that REST happened to finish first.
    expect(restInFlight).toBeGreaterThan(0);

    await Promise.all(rest);
  });
});
