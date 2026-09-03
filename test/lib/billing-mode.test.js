import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTestCharge, resetDevStoreCache, isManagedPricingRejection, describeBillingError } from "../../app/lib/billing-mode.server.js";

describe("isTestCharge — dev-store memoisation", () => {
  beforeEach(() => resetDevStoreCache());

  const graphqlReturning = (partnerDevelopment) =>
    vi.fn(async () => ({ shop: { plan: { partnerDevelopment } } }));

  it("queries Shopify once, then serves the cached answer", async () => {
    const shopifyGraphql = graphqlReturning(true);
    expect(await isTestCharge({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "v" })).toBe(true);
    expect(await isTestCharge({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "v" })).toBe(true);
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
  });

  it("caches per shop, not globally", async () => {
    const dev = graphqlReturning(true);
    const live = graphqlReturning(false);
    expect(await isTestCharge({ shopifyGraphql: dev, shop: "dev.myshopify.com", token: "t", version: "v" })).toBe(true);
    expect(await isTestCharge({ shopifyGraphql: live, shop: "live.myshopify.com", token: "t", version: "v" })).toBe(false);
  });

  it("does NOT cache a failed/unreadable lookup — it retries next call", async () => {
    let call = 0;
    const shopifyGraphql = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("network");
      return { shop: { plan: { partnerDevelopment: true } } };
    });
    expect(await isTestCharge({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "v" })).toBe(false); // fail-closed
    expect(await isTestCharge({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "v" })).toBe(true);  // retried, now known
    expect(shopifyGraphql).toHaveBeenCalledTimes(2);
  });

  it("resetDevStoreCache forces a fresh lookup", async () => {
    const shopifyGraphql = graphqlReturning(true);
    await isTestCharge({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "v" });
    resetDevStoreCache();
    await isTestCharge({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "v" });
    expect(shopifyGraphql).toHaveBeenCalledTimes(2);
  });
});

describe("isManagedPricingRejection", () => {
  it("matches Shopify's App-Pricing refusal, both phrases required", () => {
    expect(isManagedPricingRejection(new Error("Managed Pricing Apps cannot use the Billing API (to create charges)"))).toBe(true);
    expect(isManagedPricingRejection(new Error("app pricing is enabled"))).toBe(false);
    expect(isManagedPricingRejection(new Error("Internal Server Error"))).toBe(false);
  });
});

describe("describeBillingError", () => {
  it("folds message and errorData into one searchable string", () => {
    const err = Object.assign(new Error("Error while billing the store"), { errorData: [{ message: "no such plan" }] });
    expect(describeBillingError(err)).toMatch(/Error while billing the store/);
    expect(describeBillingError(err)).toMatch(/no such plan/);
  });
});
