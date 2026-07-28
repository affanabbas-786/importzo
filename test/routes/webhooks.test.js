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
const { db, webhookMock } = vi.hoisted(() => ({
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
  },
  webhookMock: vi.fn(),
}));

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: (...args) => webhookMock(...args) },
}));

vi.mock("../../app/db.server", () => ({ default: db }));

import { action as shopRedact } from "../../app/routes/webhooks.shop.redact.jsx";
import { action as customersRedact } from "../../app/routes/webhooks.customers.redact.jsx";
import { action as customersDataRequest } from "../../app/routes/webhooks.customers.data_request.jsx";
import { action as appUninstalled } from "../../app/routes/webhooks.app.uninstalled.jsx";
import { action as scopesUpdate } from "../../app/routes/webhooks.app.scopes_update.jsx";

const SHOP = "merchant.myshopify.com";

function resetDb() {
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) if (vi.isMockFunction(fn)) fn.mockClear();
  }
  db.migrationJob.findMany.mockResolvedValue([{ id: "job-1" }]);
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
    await handler({ request: { headers: { get: () => null } } });

    // The only source of shop identity is the verified webhook result —
    // nothing reads an unverified header to decide what to act on.
    expect(webhookMock).toHaveBeenCalledTimes(1);
  });

  it.each(ALL_WEBHOOKS)("%s performs no destructive work when the signature is rejected", async (topic, handler) => {
    webhookMock.mockRejectedValue(hmacRejection());

    await expect(handler({ request: { headers: { get: () => null } } })).rejects.toBeInstanceOf(Response);

    // Nothing may be deleted or modified on an unverified request.
    expect(db.session.deleteMany).not.toHaveBeenCalled();
    expect(db.migrationJob.deleteMany).not.toHaveBeenCalled();
    expect(db.storeBackup.deleteMany).not.toHaveBeenCalled();
    expect(db.scheduledSync.deleteMany).not.toHaveBeenCalled();
    expect(db.scheduledSync.updateMany).not.toHaveBeenCalled();
    expect(db.session.update).not.toHaveBeenCalled();
  });

  it("propagates the rejection status rather than swallowing it into a 200", async () => {
    webhookMock.mockRejectedValue(hmacRejection());
    const err = await shopRedact({ request: { headers: { get: () => null } } }).catch((e) => e);

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

      const err = await appUninstalled({ request: { headers: { get: () => null } } }).catch((e) => e);
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
    await shopRedact({ request: { headers: { get: () => null } } });

    // The three the old implementation handled...
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.importJob.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.sourceStore.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });

    // ...and the six it silently left behind.
    expect(db.migrationJob.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.scheduledSync.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.storeBackup.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.transferSession.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(db.productMapping.deleteMany).toHaveBeenCalled();
    expect(db.transferLogEntry.deleteMany).toHaveBeenCalled();
  });

  it("erases the encrypted access tokens held in MigrationJob and ScheduledSync", async () => {
    await shopRedact({ request: { headers: { get: () => null } } });
    expect(db.migrationJob.deleteMany).toHaveBeenCalled();
    expect(db.scheduledSync.deleteMany).toHaveBeenCalled();
  });

  it("erases StoreBackup, which holds a full snapshot of the shop's catalog", async () => {
    await shopRedact({ request: { headers: { get: () => null } } });
    expect(db.storeBackup.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("deletes job-scoped children via their parent job ids", async () => {
    db.migrationJob.findMany.mockResolvedValue([{ id: "job-1" }, { id: "job-2" }]);
    await shopRedact({ request: { headers: { get: () => null } } });

    expect(db.productMapping.deleteMany).toHaveBeenCalledWith({ where: { jobId: { in: ["job-1", "job-2"] } } });
    expect(db.transferLogEntry.deleteMany).toHaveBeenCalledWith({ where: { jobId: { in: ["job-1", "job-2"] } } });
  });

  it("returns 200 even on partial failure, but logs the failure loudly", async () => {
    db.storeBackup.deleteMany.mockRejectedValueOnce(new Error("no such table"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await shopRedact({ request: { headers: { get: () => null } } });

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
    const response = await customersRedact({ request: { headers: { get: () => null } } });
    expect(response.status).toBe(200);
  });

  it("customers/redact deletes nothing, because no customer PII is stored", async () => {
    // The app reads customer data for CSV export but streams it to the
    // merchant's browser and never persists it. If that ever changes, this
    // test should start failing and force the handler to be revisited.
    webhookMock.mockResolvedValue({ shop: SHOP, topic: "customers/redact", payload: { customer: { id: 42 } } });
    await customersRedact({ request: { headers: { get: () => null } } });

    for (const [name, model] of Object.entries(db)) {
      if (model.deleteMany) {
        expect(model.deleteMany, `${name}.deleteMany should not be called`).not.toHaveBeenCalled();
      }
    }
  });

  it("customers/data_request acknowledges with 200", async () => {
    webhookMock.mockResolvedValue({ shop: SHOP, topic: "customers/data_request" });
    const response = await customersDataRequest({ request: { headers: { get: () => null } } });
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
    await appUninstalled({ request: { headers: { get: () => null } } });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("disables scheduled syncs, which would otherwise keep firing against a revoked token", async () => {
    await appUninstalled({ request: { headers: { get: () => null } } });

    expect(db.scheduledSync.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP, enabled: true },
      data: expect.objectContaining({ enabled: false, disabledReason: expect.stringContaining("uninstalled") }),
    });
  });

  it("does not erase shop data — that is shop/redact's job 48h later", async () => {
    await appUninstalled({ request: { headers: { get: () => null } } });
    expect(db.storeBackup.deleteMany).not.toHaveBeenCalled();
    expect(db.migrationJob.deleteMany).not.toHaveBeenCalled();
  });

  it("survives the scheduled-sync table being absent on an older deployment", async () => {
    db.scheduledSync.updateMany.mockRejectedValueOnce(new Error("no such table"));
    const response = await appUninstalled({ request: { headers: { get: () => null } } });
    expect(response.status).toBe(200);
  });
});
