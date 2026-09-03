import { describe, it, expect } from "vitest";
import {
  storeHandleFromShop,
  planSelectionUrl,
  embeddedAppReturnUrl,
  DEFAULT_APP_HANDLE,
} from "../../app/lib/app-pricing.server.js";

describe("storeHandleFromShop", () => {
  it("strips the .myshopify.com suffix", () => {
    expect(storeHandleFromShop("cool-shop.myshopify.com")).toBe("cool-shop");
  });
  it("leaves a bare handle alone and tolerates junk", () => {
    expect(storeHandleFromShop("cool-shop")).toBe("cool-shop");
    expect(storeHandleFromShop(null)).toBe("");
    expect(storeHandleFromShop(undefined)).toBe("");
  });
});

describe("planSelectionUrl", () => {
  it("points at the hosted pricing_plans page inside this store's admin", () => {
    expect(planSelectionUrl({ shop: "cool-shop.myshopify.com", appHandle: "importzo" }))
      .toBe("https://admin.shopify.com/store/cool-shop/charges/importzo/pricing_plans");
  });
  it("falls back to the default handle", () => {
    expect(planSelectionUrl({ shop: "cool-shop.myshopify.com" }))
      .toContain(`/charges/${DEFAULT_APP_HANDLE}/pricing_plans`);
  });
});

describe("embeddedAppReturnUrl", () => {
  // This is the App Store review fix for the "blank page after charge
  // approval" rejection: the returnUrl handed to appSubscriptionCreate has to
  // be an EMBEDDED admin URL so the merchant lands back inside Shopify with
  // App Bridge able to initialise — not the app's bare origin.
  it("builds an admin.shopify.com/store/<store>/apps/<client-id><path> URL", () => {
    expect(embeddedAppReturnUrl({
      shop: "cool-shop.myshopify.com",
      apiKey: "70b047c7b1057f7a8ca94c044f6568ae",
      path: "/app/billing",
    })).toBe("https://admin.shopify.com/store/cool-shop/apps/70b047c7b1057f7a8ca94c044f6568ae/app/billing");
  });

  it("defaults the path to /app/billing", () => {
    expect(embeddedAppReturnUrl({ shop: "s.myshopify.com", apiKey: "KEY" }))
      .toBe("https://admin.shopify.com/store/s/apps/KEY/app/billing");
  });

  it("normalises a path given without a leading slash", () => {
    expect(embeddedAppReturnUrl({ shop: "s.myshopify.com", apiKey: "KEY", path: "app/settings" }))
      .toBe("https://admin.shopify.com/store/s/apps/KEY/app/settings");
  });

  it("never points at the app's own origin or the hosted plan page", () => {
    const url = embeddedAppReturnUrl({ shop: "s.myshopify.com", apiKey: "KEY" });
    expect(url).toMatch(/^https:\/\/admin\.shopify\.com\//);
    expect(url).not.toMatch(/importzo\.dazzletech\.co/);
    expect(url).not.toMatch(/pricing_plans/);
  });
});
