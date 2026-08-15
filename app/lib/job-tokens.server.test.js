import { describe, it, expect, vi } from "vitest";
import { createTokenProvider, isAuthError, DEFAULT_TTL_MS, RESOLVE_RETRY_MS } from "./job-tokens.server.js";

const silent = { log: () => {}, warn: () => {} };

describe("isAuthError", () => {
  it("matches the 401 shopifyGraphql throws for an expired token", () => {
    expect(isAuthError(new Error('GraphQL HTTP 401: {"errors":"[API] Invalid API key or access token"}'))).toBe(true);
  });

  it("matches 403", () => {
    expect(isAuthError(new Error("GraphQL HTTP 403: forbidden"))).toBe(true);
  });

  it("does not match failures a token refresh cannot fix", () => {
    expect(isAuthError(new Error("GraphQL HTTP 500: upstream exploded"))).toBe(false);
    expect(isAuthError(new Error("GraphQL HTTP 429: throttled"))).toBe(false);
    expect(isAuthError(new Error("GraphQL errors: [{\"message\":\"Field 'x' doesn't exist\"}]"))).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("createTokenProvider", () => {
  it("resolves a live token from the session store instead of the snapshot", async () => {
    const loadToken = vi.fn(async () => "shpua_fresh");
    const provider = createTokenProvider({
      shop: "dest.myshopify.com", fallbackToken: "shpua_stale", loadToken, logger: silent,
    });

    expect(await provider.get()).toBe("shpua_fresh");
    expect(loadToken).toHaveBeenCalledWith("dest.myshopify.com");
  });

  it("caches within the TTL, then re-resolves after it — the whole point, since offline tokens live 60 minutes", async () => {
    let clock = 0;
    const loadToken = vi.fn()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const provider = createTokenProvider({
      shop: "s.myshopify.com", fallbackToken: "snapshot", loadToken,
      now: () => clock, logger: silent,
    });

    expect(await provider.get()).toBe("token-1");
    clock += DEFAULT_TTL_MS - 1;
    expect(await provider.get()).toBe("token-1");
    expect(loadToken).toHaveBeenCalledTimes(1);

    clock += 2; // past the TTL
    expect(await provider.get()).toBe("token-2");
    expect(loadToken).toHaveBeenCalledTimes(2);
  });

  it("falls back to the stored token when the shop has no session (pasted custom-app token)", async () => {
    const loadToken = vi.fn(async () => { throw new Error("Could not find a session for shop"); });
    const provider = createTokenProvider({
      shop: "source.myshopify.com", fallbackToken: "shpat_custom_app", loadToken, logger: silent,
    });

    expect(await provider.get()).toBe("shpat_custom_app");
  });

  it("backs off after a failed resolve rather than hitting the session store every batch", async () => {
    let clock = 0;
    const loadToken = vi.fn(async () => { throw new Error("no session"); });
    const provider = createTokenProvider({
      shop: "source.myshopify.com", fallbackToken: "shpat_custom_app", loadToken,
      now: () => clock, logger: silent,
    });

    await provider.get();
    await provider.get();
    await provider.get();
    expect(loadToken).toHaveBeenCalledTimes(1);

    clock += RESOLVE_RETRY_MS + 1;
    await provider.get();
    expect(loadToken).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next get() to re-resolve — used after a 401", async () => {
    const loadToken = vi.fn()
      .mockResolvedValueOnce("expired-ish")
      .mockResolvedValueOnce("definitely-fresh");
    const provider = createTokenProvider({ shop: "s.myshopify.com", loadToken, logger: silent });

    expect(await provider.get()).toBe("expired-ish");
    provider.invalidate();
    expect(await provider.get()).toBe("definitely-fresh");
  });

  it("collapses concurrent get() calls onto one session lookup", async () => {
    const loadToken = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "shared";
    });
    const provider = createTokenProvider({ shop: "s.myshopify.com", loadToken, logger: silent });

    const all = await Promise.all([provider.get(), provider.get(), provider.get(), provider.get(), provider.get()]);
    expect(all).toEqual(["shared", "shared", "shared", "shared", "shared"]);
    expect(loadToken).toHaveBeenCalledTimes(1);
  });

  it("never throws, even with no fallback and a broken session store", async () => {
    const provider = createTokenProvider({
      shop: "s.myshopify.com",
      loadToken: async () => { throw new Error("db down"); },
      logger: silent,
    });
    await expect(provider.get()).resolves.toBeNull();
  });

  it("treats a session with no accessToken as unresolved and keeps the fallback", async () => {
    const provider = createTokenProvider({
      shop: "s.myshopify.com", fallbackToken: "snapshot",
      loadToken: async () => null, logger: silent,
    });
    expect(await provider.get()).toBe("snapshot");
  });
});
