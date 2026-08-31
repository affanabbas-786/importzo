import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// Phase 3 — Webhook security + GDPR compliance.
//
// Two things are proven here:
//   1. HMAC: every webhook route delegates to authenticate.webhook(), and
//      when that rejects (bad/missing signature) the handler does NO work
//      and the rejection propagates. Verification itself is the Shopify
//      SDK's; what's testable — and what actually protects us — is that no
//      handler runs its side effects before or around it.
//   2. GDPR: shop/redact erases every table, not the three it used to.
// ═══════════════════════════════════════════════════════════════════

// vi.mock is hoisted above normal top-level consts, so these have to be
// created inside vi.hoisted() to exist by the time the factories run.
const { db, webhookMock, shopPlanRows } = vi.hoisted(() => {
  const shopPlanRows = new Map();
  return {
    shopPlanRows,
    db: {
      session: { deleteMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})) },
      importJob: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      sourceStore: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      transferSession: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      migrationJob: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [{ id: "job-1" }]),
      },
      productMapping: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      scheduledSync: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      storeBackup: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      transferLogEntry: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      shopPlan: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        // shop/redact's complimentary-grant check reads this before deciding
        // whether to hard-delete the row or just strip its PII.
        findUnique: vi.fn(async ({ where: { shop } }) => shopPlanRows.get(shop) || null),
        // Phase 7: webhooks.app_subscriptions.update.jsx calls setShopTier
        // (usage.server.js), which goes through upsert-then-update — stateful
        // so the audit's tier-mapping tests can read back what was written.
        upsert: vi.fn(async ({ where: { shop }, update, create }) => {
          const existing = shopPlanRows.get(shop);
          if (existing) { Object.assign(existing, update); return { ...existing }; }
          const row = {
            id: "plan-1", recordsUsed: 0, aiCallsUsed: 0, subscriptionId: null, subscriptionStatus: null,
            shopOwnerEmail: null, uninstalledAt: null, createdAt: new Date(), updatedAt: new Date(), ...create,
          };
          shopPlanRows.set(shop, row);
          return { ...row };
        }),
        update: vi.fn(async ({ where: { shop }, data }) => {
          const row = shopPlanRows.get(shop);
          if (!row) throw new Error("Record to update not found.");
          Object.assign(row, data);
          return { ...row };
        }),
      },
    },
    webhookMock: vi.fn(),
  };
});

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: (...args) => webhookMock(...args) },
  // The routes reach the SDK through lib/webhook-auth.server.js, which also
  // imports this. Returning null means "no rotation in progress", i.e. the
  // ordinary single-secret behaviour these tests describe. Omitting it would
  // leave the shim calling undefined() on every rejection.
  previousSecretWebhookAuthenticator: () => null,
}));

vi.mock("../../app/db.server", () => ({ default: db }));

import { action as shopRedact } from "../../app/routes/webhooks.shop.redact.jsx";
import { action as customersRedact } from "../../app/routes/webhooks.customers.redact.jsx";
import { action as customersDataRequest } from "../../app/routes/webhooks.customers.data_request.jsx";
import { action as appUninstalled } from "../../app/routes/webhooks.app.uninstalled.jsx";
import { action as scopesUpdate } from "../../app/routes/webhooks.app.scopes_update.jsx";
import { action as appSubscriptionsUpdate } from "../../app/routes/webhooks.app_subscriptions.update.jsx";

const SHOP = "merchant.myshopify.com";

// A real POST Request, not a stub: lib/webhook-auth.server.js branches on
// request.method and reads the body, and a bare object silently skips both.
function webhookRequest() {
  return new Request("https://importzo.dazzletech.co/webhooks/test", {
    method: "POST",
    headers: { "X-Shopify-Hmac-Sha256": "sig" },
    body: JSON.stringify({ shop_id: 1 }),
  });
}

function resetDb() {
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) if (vi.isMockFunction(fn)) fn.mockClear();
  }
  db.migrationJob.findMany.mockResolvedValue([{ id: "job-1" }]);
  shopPlanRows.clear();
}

// Mirrors what the Shopify SDK throws for an invalid signature.
function hmacRejection() {
  return new Response("Unauthorized", { status: 401 });
}

const ALL_WEBHOOKS = [
  ["shop/redact", shopRedact],
  ["customers/redact", customersRedact],
  ["customers/data_request", customersDataRequest],
  ["app/uninstalled", appUninstalled],
  ["app/scopes_update", scopesUpdate],
  ["app_subscriptions/update", appSubscriptionsUpdate],
];

describe("webhook HMAC signature verification", () => {
  beforeEach(() => {
    resetDb();
    webhookMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(ALL_WEBHOOKS)("%s verifies the signature before doing any work", async (topic, handler) => {
    webhookMock.mockResolvedValue({ shop: SHOP, topic, session: null, payload: { current: [] } });
    await handler({ request: webhookRequest() });

    // The only source of shop identity is the verified webhook result —
    // nothing reads an unverified header to decide what to act on.
    expect(webhookMock).toHaveBeenCalledTimes(1);
  });

  it.each(ALL_WEBHOOKS)("%s performs no destructive work when the signature is rejected", async (topic, handler) => {
    webhookMock.mockRejectedValue(hmacRejection());

    await expect(handler({ request: webhookRequest() })).rejects.toBeInstanceOf(Response);

    // Nothing may be deleted or modified on an unverified request.
    expect(db.session.deleteMany).not.toHaveBeenCalled();
    expect(db.migrationJob.deleteMany).not.toHaveBeenCalled();
    expect(db.storeBackup.deleteMany).not.toHaveBeenCalled();
    expect(db.scheduledSync.deleteMany).not.toHaveBeenCalled();
    expect(db.scheduledSync.updateMany).not.toHaveBeenCalled();
    expect(db.session.update).not.toHaveBeenCalled();
    expect(db.shopPlan.deleteMany).not.toHaveBeenCalled();
    expect(db.shopPlan.updateMany).not.toHaveBeenCalled();
  });

  it("propagates the rejection status rather than swallowing it into a 200", async () => {
    webhookMock.mockRejectedValue(hmacRejection());
    const err = await shopRedact({ request: webhookRequest() }).catch((e) => e);

    expect(err).toBeInstanceOf(Response);
    expect(err.status).toBe(401);
  });

  // app/uninstalled deliberately tolerates one specific SDK failure (the
  // post-HMAC token refresh against an already-revoked token). That
  // tolerance must not extend to genuine auth failures.
  it("app/uninstalled still rejects real auth failures despite its token-refresh fallback", async () => {
    for (const status of [401, 400, 405]) {
      resetDb();
      webhookMock.mockReset();
      webhookMock.mockRejectedValue(new Response("nope", { status }));

      const err = await appUninstalled({ request: webhookRequest() }).catch((e) => e);
      expect(err).toBeInstanceOf(Response);
      expect(err.status).toBe(status);
      expect(db.session.deleteMany).not.toHaveBeenCalled();
    }
  });

  it("app/uninstalled tolerates a post-verification token-refresh failure and still cleans up", async () => {
    // 500 from the SDK's token refresh — HMAC already passed by then.
    webhookMock.mockRejectedValue(new Response("token dead", { status: 500 }));
    const headers = { get: (h) => (h === "X-Shopify-Shop-Domain" ? SHOP : "app/uninstalled") };

    const response = await appUninstalled({ request: { headers } });

    expect(response.status).toBe(200);
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });
});

describe("GDPR — shop/redact", () => {
  beforeEach(() => {
    resetDb();
    webhookMock.mockReset().mockResolvedValue({ shop: SHOP, topic: "shop/redact" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("erases every table holding this shop's data", async () => {
    await shopRedact({ request: webhookRequest() });

    // The three the old implementation handled...
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.importJob.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.sourceStore.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });

    // ...and the six it silently left behind.
    expect(db.migrationJob.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.scheduledSync.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.storeBackup.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    // TransferSession has no `shop` column — it records a pairing between two
    // stores, so a redact of either side must remove it.
    expect(db.transferSession.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ sourceShop: SHOP }, { destShop: SHOP }] },
    });
    expect(db.productMapping.deleteMany).toHaveBeenCalled();
    expect(db.transferLogEntry.deleteMany).toHaveBeenCalled();

    // Phase 5 — added after the original nine, must not be forgotten again.
    expect(db.shopPlan.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("erases the encrypted access tokens held in MigrationJob and ScheduledSync", async () => {
    await shopRedact({ request: webhookRequest() });
    expect(db.migrationJob.deleteMany).toHaveBeenCalled();
    expect(db.scheduledSync.deleteMany).toHaveBeenCalled();
  });

  it("erases StoreBackup, which holds a full snapshot of the shop's catalog", async () => {
    await shopRedact({ request: webhookRequest() });
    expect(db.storeBackup.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("deletes job-scoped children via their parent job ids", async () => {
    db.migrationJob.findMany.mockResolvedValue([{ id: "job-1" }, { id: "job-2" }]);
    await shopRedact({ request: webhookRequest() });

    expect(db.productMapping.deleteMany).toHaveBeenCalledWith({ where: { jobId: { in: ["job-1", "job-2"] } } });
    expect(db.transferLogEntry.deleteMany).toHaveBeenCalledWith({ where: { jobId: { in: ["job-1", "job-2"] } } });
  });

  it("retains a complimentary-grant ShopPlan row but erases its PII", async () => {
    // A complimentary Pro grant (tier=pro, subscriptionStatus=COMPLIMENTARY)
    // has no Shopify AppSubscription behind it — this row IS the grant.
    // Hard-deleting it silently revokes a deliberate permanent free grant if
    // the merchant reinstalls, so shop/redact strips the personal data and
    // keeps the grant state instead.
    shopPlanRows.set(SHOP, {
      id: "plan-1", shop: SHOP, tier: "pro", subscriptionId: null,
      subscriptionStatus: "COMPLIMENTARY", shopOwnerEmail: "owner@example.com",
      recordsUsed: 120, aiCallsUsed: 4,
    });

    const response = await shopRedact({ request: webhookRequest() });
    expect(response.status).toBe(200);

    // Row NOT hard-deleted...
    expect(db.shopPlan.deleteMany).not.toHaveBeenCalled();
    // ...PII erased, grant state untouched.
    const row = shopPlanRows.get(SHOP);
    expect(row.shopOwnerEmail).toBeNull();
    expect(row.recordsUsed).toBe(0);
    expect(row.aiCallsUsed).toBe(0);
    expect(row.tier).toBe("pro");
    expect(row.subscriptionStatus).toBe("COMPLIMENTARY");

    // Every other table is still erased as normal.
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.migrationJob.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("still hard-deletes a normal (non-complimentary) ShopPlan row", async () => {
    shopPlanRows.set(SHOP, {
      id: "plan-1", shop: SHOP, tier: "free", subscriptionId: null,
      subscriptionStatus: null, shopOwnerEmail: "owner@example.com",
    });

    await shopRedact({ request: webhookRequest() });

    expect(db.shopPlan.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("returns 200 even on partial failure, but logs the failure loudly", async () => {
    db.storeBackup.deleteMany.mockRejectedValueOnce(new Error("no such table"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await shopRedact({ request: webhookRequest() });

    // 200 because Shopify retries non-2xx, and a retry re-runs a mostly
    // successful erasure — but an incomplete deletion must not look clean.
    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FAILED to erase"),
      expect.anything(),
    );
  });
});

describe("GDPR — customers/redact and customers/data_request", () => {
  beforeEach(() => {
    resetDb();
    webhookMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("customers/redact acknowledges with 200", async () => {
    webhookMock.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 42 } } });
    const response = await customersRedact({ request: webhookRequest() });
    expect(response.status).toBe(200);
  });

  it("customers/redact deletes nothing, because no customer PII is stored", async () => {
    // The app reads customer data for CSV export but streams it to the
    // merchant's browser and never persists it. If that ever changes, this
    // test should start failing and force the handler to be revisited.
    webhookMock.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 42 } } });
    await customersRedact({ request: webhookRequest() });

    for (const [name, model] of Object.entries(db)) {
      if (model.deleteMany) {
        expect(model.deleteMany, `${name}.deleteMany should not be called`).not.toHaveBeenCalled();
      }
    }
  });

  it("customers/data_request acknowledges with 200", async () => {
    webhookMock.mockResolvedValue({ shop: SHOP, topic: "customers/data_request" });
    const response = await customersDataRequest({ request: webhookRequest() });
    expect(response.status).toBe(200);
  });

  it("both compliance endpoints expose a GET loader for Shopify's reachability probe", async () => {
    const { loader: redactLoader } = await import("../../app/routes/webhooks.customers.redact.jsx");
    const { loader: dataLoader } = await import("../../app/routes/webhooks.customers.data_request.jsx");
    const { loader: shopLoader } = await import("../../app/routes/webhooks.shop.redact.jsx");

    expect(redactLoader().status).toBe(200);
    expect(dataLoader().status).toBe(200);
    expect(shopLoader().status).toBe(200);
  });
});

describe("app/uninstalled", () => {
  beforeEach(() => {
    resetDb();
    webhookMock.mockReset().mockResolvedValue({ shop: SHOP, topic: "app/uninstalled", session: null });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("deletes the shop's sessions", async () => {
    await appUninstalled({ request: webhookRequest() });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("disables scheduled syncs, which would otherwise keep firing against a revoked token", async () => {
    await appUninstalled({ request: webhookRequest() });

    expect(db.scheduledSync.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP, enabled: true },
      data: expect.objectContaining({ enabled: false, disabledReason: expect.stringContaining("uninstalled") }),
    });
  });

  it("does not erase shop data — that is shop/redact's job 48h later", async () => {
    await appUninstalled({ request: webhookRequest() });
    expect(db.storeBackup.deleteMany).not.toHaveBeenCalled();
    expect(db.migrationJob.deleteMany).not.toHaveBeenCalled();
  });

  it("survives the scheduled-sync table being absent on an older deployment", async () => {
    db.scheduledSync.updateMany.mockRejectedValueOnce(new Error("no such table"));
    const response = await appUninstalled({ request: webhookRequest() });
    expect(response.status).toBe(200);
  });

  // Phase 5: without this, a shop's row never drops out of Agency
  // eligibility's "currently installed" count after it uninstalls.
  it("marks the shop's ShopPlan row uninstalled, so it drops out of Agency eligibility counts", async () => {
    await appUninstalled({ request: webhookRequest() });

    expect(db.shopPlan.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP },
      data: { uninstalledAt: expect.any(Date) },
    });
  });

  it("survives the shopPlan table being absent on an older deployment", async () => {
    db.shopPlan.updateMany.mockRejectedValueOnce(new Error("no such table"));
    const response = await appUninstalled({ request: webhookRequest() });
    expect(response.status).toBe(200);
  });
});

// Phase 7 — billing audit. Reacts to subscription status changes reported
// by Shopify (activation, cancellation, decline, freeze, expiry), including
// ones that happen entirely outside this app.
describe("app_subscriptions/update", () => {
  beforeEach(() => {
    resetDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  function mockWebhook(appSubscription) {
    webhookMock.mockReset().mockResolvedValue({
      shop: SHOP, topic: "app_subscriptions/update", session: null,
      payload: { app_subscription: appSubscription },
    });
  }

  it("promotes ShopPlan.tier to pro when an Importzo Pro subscription activates", async () => {
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" });
    const response = await appSubscriptionsUpdate({ request: webhookRequest() });

    expect(response.status).toBe(200);
    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "pro", subscriptionId: "gid://shopify/AppSubscription/1", subscriptionStatus: "ACTIVE" });
  });

  it("promotes ShopPlan.tier to agency when an Importzo Agency subscription activates", async () => {
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/2", name: "Importzo Agency", status: "ACTIVE" });
    await appSubscriptionsUpdate({ request: webhookRequest() });

    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "agency" });
  });

  it("drops the shop to free the moment a subscription is cancelled, without waiting for a page load", async () => {
    shopPlanRows.set(SHOP, { id: "plan-1", shop: SHOP, tier: "pro", subscriptionId: "gid://shopify/AppSubscription/1", subscriptionStatus: "ACTIVE" });
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "CANCELLED" });
    await appSubscriptionsUpdate({ request: webhookRequest() });

    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "free", subscriptionId: null, subscriptionStatus: "CANCELLED" });
  });

  it("drops the shop to free on a declined or expired charge, same as cancellation", async () => {
    for (const status of ["DECLINED", "EXPIRED", "FROZEN"]) {
      resetDb();
      shopPlanRows.set(SHOP, { id: "plan-1", shop: SHOP, tier: "agency", subscriptionId: "gid://shopify/AppSubscription/9", subscriptionStatus: "ACTIVE" });
      mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/9", name: "Importzo Agency", status });
      await appSubscriptionsUpdate({ request: webhookRequest() });

      expect(shopPlanRows.get(SHOP).tier).toBe("free");
    }
  });

  // A complimentary grant carries no subscriptionId, which satisfies the
  // `!current.subscriptionId` test the downgrade branch uses to recognise its
  // own subscription — so any unrelated inactive event would revoke the grant.
  // The event describes a subscription the grant was never backed by.
  it("leaves a complimentary grant alone when an unrelated subscription goes inactive", async () => {
    for (const status of ["CANCELLED", "DECLINED", "EXPIRED", "FROZEN"]) {
      resetDb();
      shopPlanRows.set(SHOP, { id: "plan-1", shop: SHOP, tier: "pro", subscriptionId: null, subscriptionStatus: "COMPLIMENTARY" });
      mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/77", name: "Importzo Pro", status });
      const response = await appSubscriptionsUpdate({ request: webhookRequest() });

      expect(response.status).toBe(200);
      expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "pro", subscriptionStatus: "COMPLIMENTARY" });
    }
  });

  it("still lets a genuinely activated subscription supersede a complimentary grant", async () => {
    shopPlanRows.set(SHOP, { id: "plan-1", shop: SHOP, tier: "pro", subscriptionId: null, subscriptionStatus: "COMPLIMENTARY" });
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/5", name: "Importzo Agency", status: "ACTIVE" });
    await appSubscriptionsUpdate({ request: webhookRequest() });

    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "agency", subscriptionStatus: "ACTIVE" });
  });

  it("ignores an unrecognized subscription name rather than crashing (defensive against a future renamed plan)", async () => {
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Some Other Charge", status: "ACTIVE" });
    const response = await appSubscriptionsUpdate({ request: webhookRequest() });

    expect(response.status).toBe(200);
    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "free" });
  });

  it("no-ops gracefully when the payload has no app_subscription", async () => {
    webhookMock.mockReset().mockResolvedValue({ shop: SHOP, topic: "app_subscriptions/update", session: null, payload: {} });
    const response = await appSubscriptionsUpdate({ request: webhookRequest() });
    expect(response.status).toBe(200);
    expect(shopPlanRows.has(SHOP)).toBe(false);
  });

  it("logs but still returns 200 if updating ShopPlan fails, rather than triggering endless Shopify retries", async () => {
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Importzo Pro", status: "ACTIVE" });
    db.shopPlan.upsert.mockRejectedValueOnce(new Error("db unavailable"));
    const response = await appSubscriptionsUpdate({ request: webhookRequest() });
    expect(response.status).toBe(200);
  });

  // Regression: Shopify's default plan-switch behavior (Pro -> Agency, or
  // vice versa) cancels the old subscription and activates the new one on
  // approval — which fires TWO webhooks (new plan ACTIVE, old plan
  // CANCELLED) with no guaranteed delivery order. Naively downgrading to
  // Free on any non-ACTIVE status would wrongly reset a merchant who just
  // upgraded, if the stale cancellation notification for the OLD
  // subscription happens to arrive after the new one's activation.
  it("does not downgrade to free when a stale cancellation for an already-superseded subscription arrives after the new plan's activation", async () => {
    // New Agency subscription activates first.
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/agency-1", name: "Importzo Agency", status: "ACTIVE" });
    await appSubscriptionsUpdate({ request: webhookRequest() });
    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "agency", subscriptionId: "gid://shopify/AppSubscription/agency-1" });

    // Old Pro subscription's cancellation notification arrives late.
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/pro-1", name: "Importzo Pro", status: "CANCELLED" });
    await appSubscriptionsUpdate({ request: webhookRequest() });

    // Must still be on Agency — the stale event must not have clobbered it.
    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "agency", subscriptionId: "gid://shopify/AppSubscription/agency-1" });
  });

  it("still downgrades to free when the cancellation is for the subscription actually on file (the normal, non-racing case)", async () => {
    shopPlanRows.set(SHOP, { id: "plan-1", shop: SHOP, tier: "pro", subscriptionId: "gid://shopify/AppSubscription/pro-1", subscriptionStatus: "ACTIVE" });
    mockWebhook({ admin_graphql_api_id: "gid://shopify/AppSubscription/pro-1", name: "Importzo Pro", status: "CANCELLED" });
    await appSubscriptionsUpdate({ request: webhookRequest() });

    expect(shopPlanRows.get(SHOP)).toMatchObject({ tier: "free", subscriptionId: null });
  });
});
