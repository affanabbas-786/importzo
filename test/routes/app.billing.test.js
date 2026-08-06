import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockActionRequest } from "../../app/lib/test-helpers.js";

const SHOP = "dest-shop.myshopify.com";

// Phase 5 — app.billing.jsx is the only route that ever calls
// billing.check/billing.request/setShopTier for real, so this fake models
// both the Shopify billing context (per authenticate.admin's `billing`
// return) and the shopPlan table it reconciles into.
const rows = new Map();

function setShopPlan(shop, data) {
  rows.set(shop, {
    id: "plan-preset", shop, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...data,
  });
}

vi.mock("../../app/db.server", () => ({
  default: {
    shopPlan: {
      upsert: vi.fn(async ({ where: { shop }, update, create }) => {
        const existing = rows.get(shop);
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const row = {
          id: "plan-1", recordsUsed: 0, subscriptionId: null, subscriptionStatus: null,
          shopOwnerEmail: null, uninstalledAt: null, createdAt: new Date(), updatedAt: new Date(), ...create,
        };
        rows.set(shop, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = rows.get(shop);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return { ...row };
      }),
      findUnique: vi.fn(async ({ where: { shop } }) => (rows.has(shop) ? { ...rows.get(shop) } : null)),
      count: vi.fn(async ({ where }) => {
        let list = [...rows.values()];
        if ("shopOwnerEmail" in where) list = list.filter((r) => r.shopOwnerEmail === where.shopOwnerEmail);
        if ("uninstalledAt" in where) list = list.filter((r) => r.uninstalledAt === where.uninstalledAt);
        return list.length;
      }),
    },
  },
}));

// The shop's own contact email, as agency-eligibility.server.js fetches it.
// null by default (no match, not eligible) — tests that need eligibility
// override this per-test.
const shopEmail = { value: null };
vi.mock("../../app/lib/shopify-api.server", () => ({
  shopifyGraphql: vi.fn(async () => ({ shop: { email: shopEmail.value } })),
}));

// authenticate.admin's `billing` context is configured per-test via
// currentBilling, since billing.check/.request behavior is the whole
// point of most tests here.
let currentBilling;
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(async () => ({
      session: { shop: SHOP, accessToken: "dest-token" },
      billing: currentBilling,
    })),
  },
  apiVersion: "2025-10",
}));

function fakeBilling({ appSubscriptions = [], requestImpl } = {}) {
  return {
    check: vi.fn(async () => ({ hasActivePayment: appSubscriptions.length > 0, appSubscriptions })),
    request: requestImpl || vi.fn(async () => { throw new Response(null, { status: 401 }); }),
  };
}

import { loader, action } from "../../app/routes/app.billing.jsx";

describe("app.billing loader — reconciliation", () => {
  beforeEach(() => {
    rows.clear();
    shopEmail.value = null;
    currentBilling = fakeBilling();
  });

  it("promotes ShopPlan.tier to Pro when Shopify reports an active Pro subscription", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" }],
    });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("pro");
    expect(rows.get(SHOP).subscriptionId).toBe("gid://shopify/AppSubscription/1");
    expect(rows.get(SHOP).subscriptionStatus).toBe("ACTIVE");
  });

  it("promotes ShopPlan.tier to Agency when Shopify reports an active Agency subscription", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/2", name: "Importzo Agency", status: "ACTIVE" }],
    });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("agency");
  });

  it("drops a shop back to Free when its Shopify subscription is gone", async () => {
    setShopPlan(SHOP, { tier: "pro", subscriptionId: "gid://shopify/AppSubscription/1", subscriptionStatus: "ACTIVE" });
    currentBilling = fakeBilling({ appSubscriptions: [] });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("free");
    expect(rows.get(SHOP).subscriptionId).toBeNull();
  });

  it("does not touch an already-Free shop when there's nothing active", async () => {
    currentBilling = fakeBilling({ appSubscriptions: [] });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });
    expect(data.usage.tier).toBe("free");
  });

  it("falls back to the existing ShopPlan state, without crashing, if billing.check throws", async () => {
    setShopPlan(SHOP, { tier: "agency" });
    currentBilling = fakeBilling();
    currentBilling.check = vi.fn(async () => { throw new Error("Shopify API unavailable"); });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });
    expect(data.usage.tier).toBe("agency");
  });

  it("reports Agency eligibility based on stores sharing the merchant's contact email", async () => {
    setShopPlan("other-1.myshopify.com", { shopOwnerEmail: "merchant@example.com" });
    setShopPlan("other-2.myshopify.com", { shopOwnerEmail: "merchant@example.com" });
    shopEmail.value = "merchant@example.com";

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.eligibility.eligible).toBe(true);
    expect(data.eligibility.storeCount).toBe(3); // the two others + this shop itself
  });
});

describe("app.billing action — subscribe", () => {
  beforeEach(() => {
    rows.clear();
    shopEmail.value = null;
    currentBilling = fakeBilling();
  });

  it("requests the Pro plan with a 7-day trial, USD pricing owned by shopify.server.js's config", async () => {
    const request = mockActionRequest({ intent: "subscribe", plan: "pro" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeDefined();

    expect(currentBilling.request).toHaveBeenCalledWith(expect.objectContaining({
      plan: "Importzo Pro",
      trialDays: 7,
      returnUrl: expect.stringContaining("/app/billing"),
    }));
  });

  it("requests the Agency plan when the shop is eligible", async () => {
    setShopPlan("other-1.myshopify.com", { shopOwnerEmail: "merchant@example.com" });
    setShopPlan("other-2.myshopify.com", { shopOwnerEmail: "merchant@example.com" });
    shopEmail.value = "merchant@example.com";

    const request = mockActionRequest({ intent: "subscribe", plan: "agency" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeDefined();

    expect(currentBilling.request).toHaveBeenCalledWith(expect.objectContaining({ plan: "Importzo Agency" }));
  });

  it("refuses Agency for an ineligible shop even via a direct POST, without calling billing.request", async () => {
    const request = mockActionRequest({ intent: "subscribe", plan: "agency" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(403);
    expect(currentBilling.request).not.toHaveBeenCalled();
  });

  // Regression: the app was registered for Shopify Managed Pricing in the
  // Partners Dashboard while this code drives plan selection through the
  // Billing API, so appSubscriptionCreate was rejected outright. The
  // BillingError escaped the action into the route's ErrorBoundary, which
  // swapped the whole page for "We couldn't load Billing" — the merchant
  // saw a dead page instead of Shopify's actual reason.
  it("returns Shopify's reason as JSON when billing.request fails, instead of throwing into the ErrorBoundary", async () => {
    const billingError = Object.assign(new Error("Error while billing the store"), {
      errorData: [{ field: null, message: "Managed Pricing Apps cannot use the Billing API (to create charges)." }],
    });
    currentBilling = fakeBilling({ requestImpl: vi.fn(async () => { throw billingError; }) });

    const request = mockActionRequest({ intent: "subscribe", plan: "pro" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Managed Pricing Apps cannot use the Billing API");
  });

  it("still lets billing.request's success redirect propagate", async () => {
    currentBilling = fakeBilling({
      requestImpl: vi.fn(async () => { throw new Response(null, { status: 302, headers: { Location: "/charge" } }); }),
    });

    const request = mockActionRequest({ intent: "subscribe", plan: "pro" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);
  });

  it("falls back to the error's message when Shopify sends no errorData", async () => {
    currentBilling = fakeBilling({
      requestImpl: vi.fn(async () => { throw new Error("network unreachable"); }),
    });

    const request = mockActionRequest({ intent: "subscribe", plan: "pro" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("network unreachable");
  });

  it("rejects an unknown plan id", async () => {
    const request = mockActionRequest({ intent: "subscribe", plan: "enterprise" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });
    expect(response.status).toBe(400);
  });

  it("rejects Free — there is no Shopify charge to request for it", async () => {
    const request = mockActionRequest({ intent: "subscribe", plan: "free" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });
    expect(response.status).toBe(400);
  });

  it("rejects an unsupported intent", async () => {
    const request = mockActionRequest({ intent: "cancel" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });
    expect(response.status).toBe(400);
  });
});
