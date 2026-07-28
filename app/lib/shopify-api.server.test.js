import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShopifyApi } from "./shopify-api.server.js";

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
