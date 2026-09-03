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
// Phase 10 — the shop's dev-store flag (decides test vs real charge) and its
// lifetime subscription history (decides whether the trial is still owed).
const partnerDevelopment = { value: false };
const priorSubscriptions = { value: [] };

vi.mock("../../app/lib/shopify-api.server", () => ({
  shopifyGraphql: vi.fn(async (_shop, _token, query) => {
    const text = String(query);
    // Checked BEFORE the app-handle branch: the trial-history query also
    // selects currentAppInstallation, so ordering here is load-bearing.
    if (text.includes("allSubscriptions")) {
      return { currentAppInstallation: { allSubscriptions: { nodes: priorSubscriptions.value } } };
    }
    if (text.includes("partnerDevelopment")) {
      return { shop: { plan: { partnerDevelopment: partnerDevelopment.value, shopifyPlus: false, publicDisplayName: "Basic" } } };
    }
    if (text.includes("currentAppInstallation")) {
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

// billing.request always THROWS: a Response on success (the App Bridge
// redirect out to Shopify's approval screen) or a real error on refusal. The
// fake reproduces that contract exactly, because the action's control flow
// depends on telling those two apart — see its catch block.
function fakeBilling({ appSubscriptions = [], requestThrows = null } = {}) {
  return {
    check: vi.fn(async () => ({ hasActivePayment: appSubscriptions.length > 0, appSubscriptions })),
    request: vi.fn(async () => {
      if (requestThrows) throw requestThrows;
      throw new Response(null, { status: 302, headers: { Location: "https://admin.shopify.com/approve" } });
    }),
    cancel: vi.fn(async ({ subscriptionId }) => ({ id: subscriptionId, status: "CANCELLED" })),
  };
}

// Shopify's refusal while the app is still registered for App Pricing.
const MANAGED_PRICING_ERROR = new Error(
  "Managed Pricing Apps cannot use the Billing API (to create charges)",
);

// A subscription line item shaped like Shopify's, so intervalOf() has
// something real to read monthly-vs-yearly off.
function withInterval(subscription, interval) {
  return { ...subscription, lineItems: [{ plan: { pricingDetails: { interval } } }] };
}

import { loader, action } from "../../app/routes/app.billing.jsx";
import { resetAppHandleCache } from "../../app/lib/app-pricing.server.js";

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

  // A complimentary grant is a paid tier with no Shopify subscription behind
  // it, so it hits the same "nothing active" branch as a lapsed charge above —
  // and must NOT be read the same way. Without the guard the grant is revoked
  // on the merchant's next Billing page load, silently and permanently.
  it("keeps a complimentary grant on its paid tier even though Shopify reports no subscription", async () => {
    setShopPlan(SHOP, { tier: "pro", subscriptionId: null, subscriptionStatus: "COMPLIMENTARY" });
    currentBilling = fakeBilling({ appSubscriptions: [] });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("pro");
    expect(data.usage.isUnlimited).toBe(true);
    expect(rows.get(SHOP).tier).toBe("pro");
    expect(rows.get(SHOP).subscriptionStatus).toBe("COMPLIMENTARY");
  });

  // The grant survives repeated visits, not just the first — the guard has to
  // return before the write, not merely restore the tier afterwards.
  it("keeps a complimentary grant across repeated Billing page loads", async () => {
    setShopPlan(SHOP, { tier: "pro", subscriptionId: null, subscriptionStatus: "COMPLIMENTARY" });
    currentBilling = fakeBilling({ appSubscriptions: [] });

    for (let i = 0; i < 3; i += 1) {
      await loader({ request: { url: `https://${SHOP}/app/billing` } });
    }

    expect(rows.get(SHOP).tier).toBe("pro");
  });

  // A complimentary shop that later actually subscribes is a real paying
  // merchant: the subscription supersedes the grant rather than being ignored.
  it("lets a real subscription supersede a complimentary grant", async () => {
    setShopPlan(SHOP, { tier: "pro", subscriptionId: null, subscriptionStatus: "COMPLIMENTARY" });
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/9", name: "Importzo Agency Yearly", status: "ACTIVE" }],
    });

    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.usage.tier).toBe("agency");
    expect(rows.get(SHOP).subscriptionStatus).toBe("ACTIVE");
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

  // Phase 10 — the loader no longer ships a hosted plan-page URL to the
  // client at all. Plan selection happens on this page now, so handing the
  // browser a link to Shopify's plan page would re-create the second
  // selection step this migration exists to remove. The URL is still built,
  // but only server-side, and only on the App-Pricing-still-enabled fallback
  // path in the action.
  it("does not send a hosted plan-selection URL to the client", async () => {
    liveAppHandle.value = "importzo-live";
    const data = await loader({ request: { url: `https://${SHOP}/app/billing` } });

    expect(data.planSelectionUrl).toBeUndefined();
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
// Phase 10 — the action creates the charge again, for the exact plan and
// interval the merchant pressed. The hosted plan-selection page is no longer
// part of the happy path at all; it survives only as the fallback for the
// window before Shopify App Pricing is switched off in the Partner Dashboard.
// ═══════════════════════════════════════════════════════════════════
describe("app.billing action — charge creation", () => {
  beforeEach(() => {
    rows.clear();
    shopEmail.value = null;
    liveAppHandle.value = "importzo";
    partnerDevelopment.value = false;
    priorSubscriptions.value = [];
    delete process.env.SHOPIFY_APP_HANDLE; // eslint-disable-line no-undef
    resetAppHandleCache();
    redirectMock.mockClear();
    currentBilling = fakeBilling();
  });

  // The whole point of the migration: the button pressed decides the charge.
  it.each([
    ["pro", "monthly", "Importzo Pro Monthly"],
    ["pro", "yearly", "Importzo Pro Yearly"],
    ["agency", "monthly", "Importzo Agency Monthly"],
    ["agency", "yearly", "Importzo Agency Yearly"],
  ])("charges the %s %s plan as \"%s\"", async (plan, interval, expectedKey) => {
    const request = mockActionRequest({ intent: "select-plan", plan, interval }, { url: `https://${SHOP}/app/billing` });

    // Success is a thrown Response — the redirect out to Shopify's approval.
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(
      expect.objectContaining({ plan: expectedKey }),
    );
  });

  // Phase 12 — Partner/Agency linking is flat-priced: one Agency plan key
  // regardless of companion count, and any posted partnerCount is ignored.
  it("always resolves the flat Agency plan key, ignoring any posted partnerCount", async () => {
    const request = mockActionRequest(
      { intent: "select-plan", plan: "agency", interval: "monthly", partnerCount: "3" },
      { url: `https://${SHOP}/app/billing` },
    );
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "Importzo Agency Monthly" }),
    );
  });

  it("resolves the flat Pro plan key", async () => {
    const request = mockActionRequest(
      { intent: "select-plan", plan: "pro", interval: "monthly", partnerCount: "1" },
      { url: `https://${SHOP}/app/billing` },
    );
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "Importzo Pro Monthly" }),
    );
  });

  it("returns the merchant to /app/billing after approval, not to Shopify's plan page", async () => {
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    const [[args]] = currentBilling.request.mock.calls;
    expect(args.returnUrl).toMatch(/\/app\/billing$/);
    expect(args.returnUrl).not.toMatch(/pricing_plans/);
  });

  it("never sends the merchant to the hosted plan page on the happy path", async () => {
    const request = mockActionRequest({ intent: "select-plan", plan: "agency", interval: "yearly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("defaults to monthly when no interval is posted, rather than guessing yearly", async () => {
    const request = mockActionRequest({ intent: "select-plan", plan: "pro" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "Importzo Pro Monthly" }),
    );
  });

  // The client names a tier and an interval; it never names a price. Anything
  // that does not resolve to a real billing key is refused rather than
  // charged at some default amount.
  it.each([
    ["free", "monthly"],
    ["pro", "weekly"],
    ["enterprise", "monthly"],
    ["", ""],
  ])("refuses a charge for a non-billable plan/%s %s", async (plan, interval) => {
    const request = mockActionRequest({ intent: "select-plan", plan, interval }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(400);
    expect(currentBilling.request).not.toHaveBeenCalled();
  });

  it("creates a TEST charge on a development store", async () => {
    partnerDevelopment.value = true;
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(expect.objectContaining({ isTest: true }));
  });

  // The expensive direction. A test charge against a real merchant looks
  // completely normal to them and collects nothing.
  it("creates a REAL charge on a live store", async () => {
    partnerDevelopment.value = false;
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(expect.objectContaining({ isTest: false }));
  });

  it("grants the configured trial to a shop that has never subscribed", async () => {
    priorSubscriptions.value = [];
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    const [[args]] = currentBilling.request.mock.calls;
    expect(args.trialDays).toBeUndefined();
  });

  // Without this, cancel-and-resubscribe is an unlimited free-usage loop.
  it("suppresses the trial for a shop that has already had an approved subscription", async () => {
    priorSubscriptions.value = [{ id: "gid://shopify/AppSubscription/9", name: "Importzo Pro Monthly", status: "CANCELLED" }];
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    expect(currentBilling.request).toHaveBeenCalledWith(expect.objectContaining({ trialDays: 0 }));
  });

  it("still grants the trial when the only prior subscriptions were never approved", async () => {
    priorSubscriptions.value = [{ id: "gid://shopify/AppSubscription/9", name: "Importzo Pro Monthly", status: "DECLINED" }];
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    await expect(action({ request })).rejects.toBeInstanceOf(Response);

    const [[args]] = currentBilling.request.mock.calls;
    expect(args.trialDays).toBeUndefined();
  });

  // The deploy-order safety net: this code ships BEFORE the Partner Dashboard
  // is switched off App Pricing, and must behave exactly as it did before
  // until that switch is made.
  it("falls back to the hosted plan page while App Pricing is still enabled", async () => {
    currentBilling = fakeBilling({ requestThrows: MANAGED_PRICING_ERROR });
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(redirectMock).toHaveBeenCalledWith(
      "https://admin.shopify.com/store/dest-shop/charges/importzo/pricing_plans",
      { target: "_top" },
    );
    expect(response.status).toBe(302);
  });

  it("reports a genuine Shopify failure instead of silently falling back", async () => {
    currentBilling = fakeBilling({ requestThrows: new Error("Internal Server Error") });
    const request = mockActionRequest({ intent: "select-plan", plan: "pro", interval: "monthly" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(500);
    expect(redirectMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects an unsupported intent", async () => {
    const request = mockActionRequest({ intent: "nonsense" }, { url: `https://${SHOP}/app/billing` });
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

// ═══════════════════════════════════════════════════════════════════
// Phase 10 — downgrading to Free is a cancellation, and it happens entirely
// inside the app: no charge to create, nothing for the merchant to approve.
// ═══════════════════════════════════════════════════════════════════
describe("app.billing action — cancellation", () => {
  beforeEach(() => {
    rows.clear();
    shopEmail.value = null;
    partnerDevelopment.value = false;
    priorSubscriptions.value = [];
    redirectMock.mockClear();
    currentBilling = fakeBilling();
  });

  it("cancels the live subscription and drops the shop to Free", async () => {
    setShopPlan(SHOP, { tier: "pro", subscriptionId: "gid://shopify/AppSubscription/1" });
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro Monthly", status: "ACTIVE" }],
    });

    const request = mockActionRequest({ intent: "cancel-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(currentBilling.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "gid://shopify/AppSubscription/1", prorate: true }),
    );
    await expect(response.json()).resolves.toMatchObject({ ok: true, cancelled: 1 });
    expect(rows.get(SHOP).tier).toBe("free");
  });

  // A merchant who has switched plans repeatedly can hold more than one.
  // Leaving any live would keep billing someone just told they're on Free.
  it("cancels every active subscription, not just the one it thinks is current", async () => {
    setShopPlan(SHOP, { tier: "agency" });
    currentBilling = fakeBilling({
      appSubscriptions: [
        { id: "gid://shopify/AppSubscription/1", name: "Importzo Pro Monthly", status: "ACTIVE" },
        { id: "gid://shopify/AppSubscription/2", name: "Importzo Agency Yearly", status: "ACTIVE" },
      ],
    });

    const request = mockActionRequest({ intent: "cancel-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(currentBilling.cancel).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({ cancelled: 2 });
  });

  // The critical correctness rule: never write Free locally while a charge is
  // still live, or the merchant loses features while still being billed.
  it("leaves the shop on its paid tier when Shopify refuses the cancellation", async () => {
    setShopPlan(SHOP, { tier: "pro" });
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro Monthly", status: "ACTIVE" }],
    });
    currentBilling.cancel = vi.fn(async () => { throw new Error("Shopify said no"); });

    const request = mockActionRequest({ intent: "cancel-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(500);
    expect(rows.get(SHOP).tier).toBe("pro");
  });

  it("is a no-op for a shop that is already on Free", async () => {
    setShopPlan(SHOP, { tier: "free" });
    const request = mockActionRequest({ intent: "cancel-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(currentBilling.cancel).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ ok: true, alreadyFree: true });
  });

  // A complimentary shop also has zero active subscriptions, so it reaches the
  // same branch as the already-Free case above. There is no charge to stop and
  // the grant is an account decision, so a stray click must not undo it.
  it("refuses to cancel a complimentary grant and leaves the tier intact", async () => {
    setShopPlan(SHOP, { tier: "pro", subscriptionId: null, subscriptionStatus: "COMPLIMENTARY" });

    const request = mockActionRequest({ intent: "cancel-plan" }, { url: `https://${SHOP}/app/billing` });
    const response = await action({ request });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(currentBilling.cancel).not.toHaveBeenCalled();
    expect(rows.get(SHOP).tier).toBe("pro");
    expect(rows.get(SHOP).subscriptionStatus).toBe("COMPLIMENTARY");
  });

  it("never leaves the app — cancellation redirects nowhere", async () => {
    setShopPlan(SHOP, { tier: "pro" });
    currentBilling = fakeBilling({
      appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Importzo Pro Monthly", status: "ACTIVE" }],
    });

    const request = mockActionRequest({ intent: "cancel-plan" }, { url: `https://${SHOP}/app/billing` });
    await action({ request });

    expect(redirectMock).not.toHaveBeenCalled();
  });
});
