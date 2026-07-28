import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkRateLimit, acquireSlot, currentConcurrency, enforcePolicy, withPolicy,
  POLICIES, bucketKey, __resetRateLimitState,
} from "./rate-limit.server.js";

const SHOP = "merchant.myshopify.com";
const OTHER = "other.myshopify.com";

beforeEach(() => __resetRateLimitState());

describe("checkRateLimit", () => {
  it("allows requests up to the limit, then blocks", () => {
    const opts = { limitName: "t", shop: SHOP, limit: 3, windowMs: 1000, now: 0 };
    expect(checkRateLimit(opts).allowed).toBe(true);
    expect(checkRateLimit(opts).allowed).toBe(true);
    expect(checkRateLimit(opts).allowed).toBe(true);
    expect(checkRateLimit(opts).allowed).toBe(false);
  });

  it("counts down remaining accurately", () => {
    const opts = { limitName: "t", shop: SHOP, limit: 3, windowMs: 1000, now: 0 };
    expect(checkRateLimit(opts).remaining).toBe(2);
    expect(checkRateLimit(opts).remaining).toBe(1);
    expect(checkRateLimit(opts).remaining).toBe(0);
  });

  it("resets once the window elapses", () => {
    const base = { limitName: "t", shop: SHOP, limit: 1, windowMs: 1000 };
    expect(checkRateLimit({ ...base, now: 0 }).allowed).toBe(true);
    expect(checkRateLimit({ ...base, now: 500 }).allowed).toBe(false);
    expect(checkRateLimit({ ...base, now: 1000 }).allowed).toBe(true);
  });

  // The core "one shop can't starve another" property.
  it("isolates shops from one another", () => {
    const base = { limitName: "t", limit: 1, windowMs: 1000, now: 0 };
    expect(checkRateLimit({ ...base, shop: SHOP }).allowed).toBe(true);
    expect(checkRateLimit({ ...base, shop: SHOP }).allowed).toBe(false);
    // A different shop is unaffected by the first shop exhausting its bucket.
    expect(checkRateLimit({ ...base, shop: OTHER }).allowed).toBe(true);
  });

  it("isolates different limits for the same shop", () => {
    const base = { shop: SHOP, limit: 1, windowMs: 1000, now: 0 };
    expect(checkRateLimit({ ...base, limitName: "a" }).allowed).toBe(true);
    expect(checkRateLimit({ ...base, limitName: "b" }).allowed).toBe(true);
  });

  it("reports a positive retryAfter when blocked", () => {
    const base = { limitName: "t", shop: SHOP, limit: 1, windowMs: 60_000 };
    checkRateLimit({ ...base, now: 0 });
    const blocked = checkRateLimit({ ...base, now: 1000 });
    expect(blocked.retryAfterSeconds).toBe(59);
  });

  it("never reports retryAfter of 0 while blocked", () => {
    const base = { limitName: "t", shop: SHOP, limit: 1, windowMs: 1000 };
    checkRateLimit({ ...base, now: 0 });
    // 1ms before reset — must still round up to at least 1s.
    expect(checkRateLimit({ ...base, now: 999 }).retryAfterSeconds).toBe(1);
  });

  it("groups an absent shop under a single explicit key rather than undefined", () => {
    expect(bucketKey("t", undefined)).toBe("t:(unknown)");
  });
});

describe("acquireSlot", () => {
  it("grants slots up to the cap and refuses beyond it", () => {
    const opts = { limitName: "c", shop: SHOP, maxConcurrent: 2 };
    expect(acquireSlot(opts)).toBeTypeOf("function");
    expect(acquireSlot(opts)).toBeTypeOf("function");
    expect(acquireSlot(opts)).toBeNull();
  });

  it("frees the slot on release", () => {
    const opts = { limitName: "c", shop: SHOP, maxConcurrent: 1 };
    const release = acquireSlot(opts);
    expect(acquireSlot(opts)).toBeNull();
    release();
    expect(acquireSlot(opts)).toBeTypeOf("function");
  });

  it("ignores a double release, so a shop can't leak slots past the cap", () => {
    const opts = { limitName: "c", shop: SHOP, maxConcurrent: 1 };
    const release = acquireSlot(opts);
    release();
    release(); // second call must be a no-op
    release();

    expect(acquireSlot(opts)).toBeTypeOf("function");
    expect(acquireSlot(opts)).toBeNull(); // cap still 1, not inflated
  });

  it("tracks concurrency per shop", () => {
    acquireSlot({ limitName: "c", shop: SHOP, maxConcurrent: 2 });
    expect(currentConcurrency("c", SHOP)).toBe(1);
    expect(currentConcurrency("c", OTHER)).toBe(0);
  });

  it("lets a second shop run while the first is at its cap", () => {
    const opts = { limitName: "c", maxConcurrent: 1 };
    expect(acquireSlot({ ...opts, shop: SHOP })).toBeTypeOf("function");
    expect(acquireSlot({ ...opts, shop: SHOP })).toBeNull();
    expect(acquireSlot({ ...opts, shop: OTHER })).toBeTypeOf("function");
  });

  it("cleans up the counter entry when the last slot is released", () => {
    const release = acquireSlot({ limitName: "c", shop: SHOP, maxConcurrent: 1 });
    release();
    expect(currentConcurrency("c", SHOP)).toBe(0);
  });
});

describe("POLICIES", () => {
  it("defines every policy the routes reference", () => {
    for (const name of ["backup", "restore", "rollback", "preview", "scheduleAdmin", "migrationJob"]) {
      expect(POLICIES[name], `missing policy ${name}`).toBeDefined();
      expect(POLICIES[name].limit).toBeGreaterThan(0);
      expect(POLICIES[name].maxConcurrent).toBeGreaterThan(0);
    }
  });

  it("caps the destructive and store-wide operations at one at a time", () => {
    // These either rewrite or delete the whole catalog — never run two
    // concurrently for the same shop.
    expect(POLICIES.backup.maxConcurrent).toBe(1);
    expect(POLICIES.restore.maxConcurrent).toBe(1);
    expect(POLICIES.rollback.maxConcurrent).toBe(1);
  });
});

describe("enforcePolicy", () => {
  it("allows a first request and returns a release function", () => {
    const gate = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(gate.ok).toBe(true);
    expect(gate.release).toBeTypeOf("function");
  });

  it("returns a 429 with Retry-After once the rate limit is hit", async () => {
    const limit = POLICIES.backup.limit;
    for (let i = 0; i < limit; i++) {
      const gate = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
      gate.release?.();
    }

    const blocked = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(blocked.ok).toBe(false);
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get("Retry-After")).toBeTruthy();
    expect((await blocked.response.json()).error).toMatch(/rate limit exceeded/i);
  });

  it("returns a 429 when the concurrency cap is reached, with a distinct message", async () => {
    const first = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(first.ok).toBe(true);

    // Under the rate limit, but the single concurrency slot is taken.
    const second = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(second.ok).toBe(false);
    expect(second.response.status).toBe(429);
    expect((await second.response.json()).error).toMatch(/already running/i);
  });

  it("lets the next request through once the slot is released", () => {
    const first = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    first.release();
    expect(enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 }).ok).toBe(true);
  });

  it("does not let one shop's saturation block another", () => {
    const a = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(a.ok).toBe(true);
    expect(enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 }).ok).toBe(false);
    expect(enforcePolicy({ policyName: "backup", shop: OTHER, now: 0 }).ok).toBe(true);
  });

  it("throws on an unknown policy name so typos surface immediately", () => {
    expect(() => enforcePolicy({ policyName: "nope", shop: SHOP })).toThrow(/unknown policy/);
  });

  it("sets no-store so a 429 is never cached", () => {
    const first = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(first.ok).toBe(true);
    const blocked = enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 });
    expect(blocked.response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("withPolicy", () => {
  it("runs the handler and returns its result", async () => {
    const result = await withPolicy({ policyName: "preview", shop: SHOP, now: 0 }, async () => "done");
    expect(result).toBe("done");
  });

  it("releases the slot after success", async () => {
    await withPolicy({ policyName: "backup", shop: SHOP, now: 0 }, async () => "ok");
    expect(currentConcurrency("backup", SHOP)).toBe(0);
  });

  it("releases the slot even when the handler throws, so a crash can't wedge the shop", async () => {
    await expect(
      withPolicy({ policyName: "backup", shop: SHOP, now: 0 }, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    expect(currentConcurrency("backup", SHOP)).toBe(0);
    // And the shop can immediately try again.
    expect(enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 }).ok).toBe(true);
  });

  it("returns the 429 without invoking the handler when blocked", async () => {
    enforcePolicy({ policyName: "backup", shop: SHOP, now: 0 }); // take the slot
    const handler = vi.fn();

    const response = await withPolicy({ policyName: "backup", shop: SHOP, now: 0 }, handler);

    expect(response.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it("serializes concurrent expensive calls for one shop", async () => {
    // Two simultaneous backups: the second must be refused, not queued.
    let resolveFirst;
    const firstDone = new Promise((r) => { resolveFirst = r; });

    const firstCall = withPolicy({ policyName: "backup", shop: SHOP, now: 0 }, () => firstDone);
    const secondCall = await withPolicy({ policyName: "backup", shop: SHOP, now: 0 }, async () => "second ran");

    expect(secondCall.status).toBe(429);
    resolveFirst("first ran");
    expect(await firstCall).toBe("first ran");
  });
});
