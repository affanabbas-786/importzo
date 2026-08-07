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
    agencyIneligibleSince: null, createdAt: new Date(), updatedAt: new Date(), ...data,
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
// Phase 8 — the app handle Shopify reports for this install, used to build
// the hosted plan-selection URL. null models a lookup that returns nothing,
// which must fall back to DEFAULT_APP_HANDLE rather than produce a broken URL.
const liveAppHandle = { value: "importzo" };

// One mock serves both queries the billing route issues; it dispatches on the
// query text so a test can move the app-handle lookup independently of the
// shop-email one.
vi.mock("../../app/lib/shopify-api.server", () => ({
  shopifyGraphql: vi.fn(async (_shop, _token, query) => {
    if (String(query).includes("currentAppInstallation")) {
      return { currentAppInstallation: { app: { handle: liveAppHandle.value } } };
    }
    return { shop: { email: shopEmail.value } };
  }),
}));

// authenticate.admin's `billing` context is configured per-test via
// currentBilling, since billing.check behavior is the whole point of the
// loader tests. `redirect` is the App Bridge-aware helper the action now
// uses to leave the embedded iframe — see the action in app.billing.jsx.
let currentBilling;
const redirectMock = vi.fn((url, opts) => new Response(null, {
  status: 302,
  headers: { Location: url, "X-Redirect-Target": opts?.target || "" },
}));

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(async () => ({
      session: { shop: SHOP, accessToken: "dest-token" },
      billing: currentBilling,
      redirect: redirectMock,
    })),
  },
  apiVersion: "2025-10",
}));

function fakeBilling({ appSubscriptions = [] } = {}) {
  return {
    check: vi.fn(async () => ({ hasActivePayment: appSubscriptions.length > 0, appSubscriptions })),
  };
}

// A subscription line item shaped like Shopify's, so intervalOf() has
// something real to read monthly-vs-yearly off.
function withInterval(subscription, interval) {
  return { ...subscription, lineItems: [{ plan: { pricingDetails: { interval } } }] };
}

import { loader, action } from "../../app/routes/app.billing.jsx";
import { resetAppHandleCache, DEFAULT_APP_HANDLE } from "../../app/lib/app-pricing.server.js";

describe("app.billing loader — reconciliation", () => {
  beforeEach(() => {
    rows.clear();
    shopEmail.value = null;
    liveAppHandle.value = "importzo";
    delete process.env.SHOPIFY_APP_HANDLE; // eslint-disable-line no-undef
    resetAppHandleCache();
    redirectMock.mockClear();
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

  // ── Phase 8 — Shopify App Pricing ──────────────────────────────────

  // Under App Pricing the plan name comes from the Partner Dashboard, in the
  // merchant's own language, and monthly/yearly variants may be named
  // separately. An exact-match lookup would fail to recognise a real paid
  // subscription and silently drop a paying merchant to Free.
  it.each([
    ["Importzo Pro", "pro"],
    ["Pro", "pro"],
    ["Pro Annual", "pro"],
    ["Importzo Pro (Yearly)", "pro"],
    ["Importzo Agency", "agency"],
    ["Agency Yearly", "agency"],
  ])("recognises the dashboard-named plan %j as tier %j", async (name, tier) => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/9", name, status: "ACTIVE" }],
    });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });
    expect(data.usage.tier).toBe(tier);
  });

  it("reads the billing interval off the subscription's recurring line item", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [withInterval(
        { id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" },
        "ANNUAL",
      )],
    });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("pro");
    expect(data.usage.interval).toBe("yearly");
  });

  it("reports a monthly subscription as monthly", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [withInterval(
        { id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" },
        "EVERY_30_DAYS",
      )],
    });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });
    expect(data.usage.interval).toBe("monthly");
  });

  it("leaves the interval null when Shopify sends no line items, rather than guessing", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" }],
    });
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });
    expect(data.usage.interval).toBeNull();
  });

  it("builds the hosted plan-selection URL from the live app handle and the store handle", async () => {
    liveAppHandle.value = "importzo-live";
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.planSelectionUrl)
      .toBe("https://admin.shopify.com/store/dest-shop/charges/importzo-live/pricing_plans");
  });

  it("falls back to the default handle when Shopify reports none, rather than emitting a broken URL", async () => {
    liveAppHandle.value = null;
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.planSelectionUrl)
      .toBe(`https://admin.shopify.com/store/dest-shop/charges/${DEFAULT_APP_HANDLE}/pricing_plans`);
  });

  // The Agency eligibility rule can't be enforced on Shopify's hosted page,
  // so the app records the discrepancy instead of blocking or revoking.
  it("flags a shop that holds Agency without meeting the store requirement", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/2", name: "Importzo Agency", status: "ACTIVE" }],
    });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("agency"); // access is NOT revoked
    expect(data.eligibility.eligible).toBe(false);
    expect(data.usage.agencyIneligibleSince).toBeInstanceOf(Date);
    expect(rows.get(SHOP).agencyIneligibleSince).toBeInstanceOf(Date);
  });

  it("keeps the original flag date on a re-visit, so it answers 'since when'", async () => {
    const original = new Date("2026-01-01T00:00:00.000Z");
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/2", name: "Importzo Agency", status: "ACTIVE" }],
    });
    setShopPlan(SHOP, { tier: "agency", agencyIneligibleSince: original });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.agencyIneligibleSince).toEqual(original);
  });

  it("clears the flag once the merchant reaches the store threshold", async () => {
    setShopPlan(SHOP, { tier: "agency", agencyIneligibleSince: new Date("2026-01-01T00:00:00.000Z") });
    setShopPlan("other-1.myshopify.com", { shopOwnerEmail: "merchant@example.com" });
    setShopPlan("other-2.myshopify.com", { shopOwnerEmail: "merchant@example.com" });
    shopEmail.value = "merchant@example.com";
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/2", name: "Importzo Agency", status: "ACTIVE" }],
    });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.eligibility.eligible).toBe(true);
    expect(data.usage.agencyIneligibleSince).toBeNull();
    expect(rows.get(SHOP).agencyIneligibleSince).toBeNull();
  });

  it("does not flag an ineligible shop that is merely on Pro", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" }],
    });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.eligibility.eligible).toBe(false);
    expect(data.usage.agencyIneligibleSince).toBeNull();
  });

  it("passes Shopify's post-approval plan_handle through as a confirmation signal only", async () => {
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" }],
    });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing?plan_handle=pro-yearly` } });

    expect(data.justSelectedPlan).toBe("pro-yearly");
    expect(data.usage.tier).toBe("pro"); // from billing.check, never from the URL
  });

  // A merchant editing the URL must not be able to talk themselves onto a
  // paid tier — the parameter is display-only.
  it("ignores plan_handle when Shopify reports no active subscription", async () => {
    currentBilling = fakeBilling({ appSubscriptions: [] });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing?plan_handle=agency-yearly` } });

    expect(data.usage.tier).toBe("free");
  });
});


// ═══════════════════════════════════════════════════════════════════
// Phase 8 — the action no longer creates a charge. Shopify rejects
// appSubscriptionCreate for App Pricing apps outright, so the only thing
// left to do is send the merchant to Shopify's own hosted plan page.
// ═══════════════════════════════════════════════════════════════════
describe("app.billing action — plan selection redirect", () => {
  beforeEach(() => {
    rows.clear();
    shopEmail.value = null;
    liveAppHandle.value = "importzo";
    delete process.env.SHOPIFY_APP_HANDLE; // eslint-disable-line no-undef
    resetAppHandleCache();
    redirectMock.mockClear();
    currentBilling = fakeBilling();
  });

  it("redirects to Shopify's hosted plan page at the top level, escaping the embedded iframe", async () => {
    const request = mockActionRequest({ intent: "select-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(redirectMock).toHaveBeenCalledWith(
      "https://admin.shopify.com/store/dest-shop/charges/importzo/pricing_plans",
      { target: "_top" },
    );
    expect(response.headers.get("Location"))
      .toBe("https://admin.shopify.com/store/dest-shop/charges/importzo/pricing_plans");
    expect(response.headers.get("X-Redirect-Target")).toBe("_top");
  });

  it("uses the live app handle Shopify reports, not the hard-coded fallback", async () => {
    liveAppHandle.value = "importzo-live";
    const request = mockActionRequest({ intent: "select-plan" }, { url: `https://${SHOP}/app/billing` });
    await action({ request });

    expect(redirectMock).toHaveBeenCalledWith(
      "https://admin.shopify.com/store/dest-shop/charges/importzo-live/pricing_plans",
      { target: "_top" },
    );
  });

  it("honours the SHOPIFY_APP_HANDLE override ahead of the live lookup", async () => {
    process.env.SHOPIFY_APP_HANDLE = "importzo-override"; // eslint-disable-line no-undef
    const request = mockActionRequest({ intent: "select-plan" }, { url: `https://${SHOP}/app/billing` });
    await action({ request });

    expect(redirectMock).toHaveBeenCalledWith(
      expect.stringContaining("/charges/importzo-override/pricing_plans"),
      { target: "_top" },
    );
  });

  // Regression guard for the whole point of Phase 8: this route must never
  // attempt a charge again. Shopify answers appSubscriptionCreate from an
  // App Pricing app with "Managed Pricing Apps cannot use the Billing API".
  it("never calls billing.request — the Billing API write path is gone", async () => {
    const request = mockActionRequest({ intent: "select-plan" }, { url: `https://${SHOP}/app/billing` });
    await action({ request });

    expect(currentBilling.request).toBeUndefined();
  });

  // Agency eligibility is deliberately NOT enforced here any more: there is
  // one hosted page for every plan, so there is no per-plan request to
  // refuse. It's surfaced before the click and recorded after it instead.
  it("redirects an Agency-ineligible shop just the same, rather than blocking the page", async () => {
    const request = mockActionRequest({ intent: "select-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(302);
    expect(redirectMock).toHaveBeenCalled();
  });

  it("rejects an unsupported intent", async () => {
    const request = mockActionRequest({ intent: "cancel" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(400);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("rejects the old 'subscribe' intent, so a stale client can't silently no-op", async () => {
    const request = mockActionRequest({ intent: "subscribe", plan: "pro" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(400);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
