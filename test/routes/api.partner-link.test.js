import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockActionRequest } from "../../app/lib/test-helpers.js";

const SHOP = "dest-shop.myshopify.com";
const db = { plans: new Map() };

function setShopPlan(shop, data) {
  db.plans.set(shop, {
    id: `plan-${shop}`, shop, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    partnerLinkedTo: null, partnerLinkNoticeDismissedAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...data,
  });
}

function matches(row, where = {}) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => {
  const shopPlanModel = {
    findUnique: vi.fn(async ({ where: { shop } }) => (db.plans.has(shop) ? { ...db.plans.get(shop) } : null)),
    update: vi.fn(async ({ where: { shop }, data }) => {
      const row = db.plans.get(shop);
      if (!row) throw new Error("Record to update not found.");
      Object.assign(row, data);
      return { ...row };
    }),
    count: vi.fn(async ({ where }) => [...db.plans.values()].filter((r) => matches(r, where)).length),
    findMany: vi.fn(async ({ where, select, orderBy } = {}) => {
      let rows = [...db.plans.values()].filter((r) => matches(r, where));
      if (orderBy?.shop === "asc") rows = [...rows].sort((a, b) => a.shop.localeCompare(b.shop));
      if (select) rows = rows.map((r) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]])));
      return rows;
    }),
    upsert: vi.fn(async ({ where: { shop }, update, create }) => {
      const existing = db.plans.get(shop);
      if (existing) { Object.assign(existing, update); return { ...existing }; }
      const row = { id: `plan-${shop}`, recordsUsed: 0, subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null, createdAt: new Date(), updatedAt: new Date(), ...create };
      db.plans.set(shop, row);
      return { ...row };
    }),
  };
  const prisma = { shopPlan: shopPlanModel };
  prisma.$transaction = vi.fn(async (fn) => fn(prisma));
  return { default: prisma };
});

import { loader, action } from "../../app/routes/api.partner-link.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";

describe("api.partner-link", () => {
  beforeEach(() => {
    __resetRateLimitState();
    db.plans = new Map();
    setShopPlan(SHOP, { tier: "agency" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects non-POST on the action", async () => {
    const response = await action({ request: { method: "GET", formData: async () => new FormData() } });
    expect(response.status).toBe(405);
  });

  it("400s on an unknown intent", async () => {
    const response = await action({ request: mockActionRequest({ intent: "bogus" }) });
    expect(response.status).toBe(400);
  });

  describe("loader", () => {
    it("reports this shop's linked partners and count", async () => {
      setShopPlan("b1.myshopify.com", { partnerLinkedTo: SHOP, tier: "pro" });
      setShopPlan("b2.myshopify.com", { partnerLinkedTo: SHOP, tier: "pro" });
      const body = await (await loader({ request: { url: "https://app.test/api/partner-link" } })).json();
      expect(body.ok).toBe(true);
      expect(body.count).toBe(2);
      expect(body.partners.map((p) => p.shop).sort()).toEqual(["b1.myshopify.com", "b2.myshopify.com"]);
    });
  });

  describe("link-partner", () => {
    // Companion just needs Importzo installed (a ShopPlan row, not
    // soft-uninstalled) — linking is direct by domain, no pairing code.
    function seedPartner(overrides = {}) {
      setShopPlan("partner.myshopify.com", { tier: "free", uninstalledAt: null, ...overrides });
    }

    it("links a companion by domain and reports it back", async () => {
      seedPartner();
      const body = await (await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com" }),
      })).json();

      expect(body.ok).toBe(true);
      expect(db.plans.get("partner.myshopify.com")).toMatchObject({ partnerLinkedTo: SHOP, tier: "pro", subscriptionStatus: "PARTNER_LINKED" });
    });

    it("400s when no store with Importzo is found at that domain", async () => {
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "nobody.myshopify.com" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).ok).toBe(false);
    });

    it("400s and does not link when the payer is on Free", async () => {
      setShopPlan(SHOP, { tier: "free" });
      seedPartner();
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com" }),
      });
      expect(response.status).toBe(400);
      expect(db.plans.get("partner.myshopify.com").partnerLinkedTo).toBeNull();
    });

    it("400s at the Pro cap of 1 companion", async () => {
      setShopPlan(SHOP, { tier: "pro" });
      setShopPlan("already.myshopify.com", { partnerLinkedTo: SHOP });
      seedPartner();
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns a warning (not a hard failure) when the companion already has its own active subscription", async () => {
      seedPartner({ subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" });
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com" }),
      });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.warning).toBe(true);
      expect(db.plans.get("partner.myshopify.com").partnerLinkedTo).toBeNull(); // nothing written yet
    });

    it("proceeds and links (without touching the companion's own subscription) once confirmOverwrite is set", async () => {
      seedPartner({ subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" });
      const body = await (await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", confirmOverwrite: "true" }),
      })).json();
      expect(body.ok).toBe(true);
      const row = db.plans.get("partner.myshopify.com");
      expect(row.partnerLinkedTo).toBe(SHOP);
      expect(row.subscriptionId).toBe("gid://own-sub"); // untouched
    });
  });

  describe("dismiss-link-notice", () => {
    it("acknowledges the companion banner on the authenticated shop", async () => {
      setShopPlan(SHOP, { partnerLinkedTo: "payer.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED" });
      const body = await (await action({ request: mockActionRequest({ intent: "dismiss-link-notice" }) })).json();
      expect(body.ok).toBe(true);
      expect(body.dismissed).toBe(true);
      expect(db.plans.get(SHOP).partnerLinkNoticeDismissedAt).toBeInstanceOf(Date);
    });

    it("is a harmless no-op for a shop that isn't a companion", async () => {
      const body = await (await action({ request: mockActionRequest({ intent: "dismiss-link-notice" }) })).json();
      expect(body).toMatchObject({ ok: true, dismissed: false });
    });
  });

  describe("remove-partner", () => {
    it("unlinks a partner currently funded by this payer", async () => {
      setShopPlan("b.myshopify.com", { partnerLinkedTo: SHOP, tier: "pro", subscriptionStatus: "PARTNER_LINKED" });
      const body = await (await action({ request: mockActionRequest({ intent: "remove-partner", partnerShop: "b.myshopify.com" }) })).json();
      expect(body.ok).toBe(true);
      expect(db.plans.get("b.myshopify.com")).toMatchObject({ tier: "free", partnerLinkedTo: null });
    });

    it("404s for a store not funded by this payer, and leaves it untouched", async () => {
      setShopPlan("b.myshopify.com", { partnerLinkedTo: "someone-else.myshopify.com", tier: "pro" });
      const response = await action({ request: mockActionRequest({ intent: "remove-partner", partnerShop: "b.myshopify.com" }) });
      expect(response.status).toBe(404);
      expect(db.plans.get("b.myshopify.com").partnerLinkedTo).toBe("someone-else.myshopify.com");
    });

    it("404s for a store that doesn't exist", async () => {
      const response = await action({ request: mockActionRequest({ intent: "remove-partner", partnerShop: "nobody.myshopify.com" }) });
      expect(response.status).toBe(404);
    });
  });

  describe("unlink-self", () => {
    it("unlinks the authenticated shop from its current payer", async () => {
      setShopPlan(SHOP, { partnerLinkedTo: "payer.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED" });
      const body = await (await action({ request: mockActionRequest({ intent: "unlink-self" }) })).json();
      expect(body.ok).toBe(true);
      expect(db.plans.get(SHOP)).toMatchObject({ tier: "free", partnerLinkedTo: null });
    });
  });
});
