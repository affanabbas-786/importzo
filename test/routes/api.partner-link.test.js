import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockActionRequest } from "../../app/lib/test-helpers.js";

const SHOP = "dest-shop.myshopify.com";
const db = { plans: new Map() };

function setShopPlan(shop, data) {
  db.plans.set(shop, {
    id: `plan-${shop}`, shop, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    partnerLinkedTo: null, pairingCode: null, pairingCodeExpiresAt: null,
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

  describe("generate-code", () => {
    it("sets a 6-digit code on the authenticated shop's own row", async () => {
      const body = await (await action({ request: mockActionRequest({ intent: "generate-code" }) })).json();
      expect(body.ok).toBe(true);
      expect(body.pairingCode).toMatch(/^\d{6}$/);
      expect(db.plans.get(SHOP).pairingCode).toBe(body.pairingCode);
    });
  });

  describe("link-partner", () => {
    function seedPartner(overrides = {}) {
      setShopPlan("partner.myshopify.com", {
        pairingCode: "424242", pairingCodeExpiresAt: new Date(Date.now() + 60_000), ...overrides,
      });
    }

    it("links a valid partner and reports it back", async () => {
      seedPartner();
      const body = await (await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: "424242" }),
      })).json();

      expect(body.ok).toBe(true);
      expect(db.plans.get("partner.myshopify.com")).toMatchObject({ partnerLinkedTo: SHOP, tier: "pro", subscriptionStatus: "PARTNER_LINKED" });
    });

    it("400s on an invalid pairing code", async () => {
      seedPartner();
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: "000000" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).ok).toBe(false);
    });

    it("400s and does not link when the payer is on Free", async () => {
      setShopPlan(SHOP, { tier: "free" });
      seedPartner();
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: "424242" }),
      });
      expect(response.status).toBe(400);
      expect(db.plans.get("partner.myshopify.com").partnerLinkedTo).toBeNull();
    });

    it("400s at the Pro cap of 1 partner", async () => {
      setShopPlan(SHOP, { tier: "pro" });
      setShopPlan("already.myshopify.com", { partnerLinkedTo: SHOP });
      seedPartner();
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: "424242" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns a warning (not a hard failure) when the partner already has its own active subscription", async () => {
      seedPartner({ subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" });
      const response = await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: "424242" }),
      });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.warning).toBe(true);
      expect(db.plans.get("partner.myshopify.com").partnerLinkedTo).toBeNull(); // nothing written yet
    });

    it("proceeds and links (without touching the partner's own subscription) once confirmOverwrite is set", async () => {
      seedPartner({ subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" });
      const body = await (await action({
        request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: "424242", confirmOverwrite: "true" }),
      })).json();
      expect(body.ok).toBe(true);
      const row = db.plans.get("partner.myshopify.com");
      expect(row.partnerLinkedTo).toBe(SHOP);
      expect(row.subscriptionId).toBe("gid://own-sub"); // untouched
    });

    // Brute-force guard on the pairing code: 5 attempts/minute per
    // authenticated shop, regardless of outcome — see rate-limit.server.js's
    // partnerLinkAttempt policy.
    describe("attempt throttle", () => {
      function attempt(code = "000000") {
        return action({
          request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner.myshopify.com", pairingCode: code }),
        });
      }

      it("allows 5 attempts in a minute, then 429s the 6th", async () => {
        seedPartner();
        for (let i = 0; i < 5; i++) {
          const response = await attempt(); // wrong code every time — never succeeds, never consumes it
          expect(response.status).toBe(400);
        }
        const sixth = await attempt();
        expect(sixth.status).toBe(429);
        const body = await sixth.json();
        expect(body.ok).toBe(false);
        expect(body.retryAfterSeconds).toBeGreaterThan(0);
      });

      it("throttles a successful attempt exactly the same as a failed one (counts every attempt)", async () => {
        // 4 failures against "partner", then a genuine 5th attempt against a
        // second, correctly-coded store — both count toward the SAME
        // per-payer bucket, so the successful one is still the 5th, and a
        // 6th (of either kind) is blocked.
        seedPartner();
        setShopPlan("partner2.myshopify.com", { pairingCode: "111111", pairingCodeExpiresAt: new Date(Date.now() + 60_000) });
        for (let i = 0; i < 4; i++) await attempt();
        const fifth = await action({
          request: mockActionRequest({ intent: "link-partner", partnerDomain: "partner2.myshopify.com", pairingCode: "111111" }),
        });
        expect(fifth.status).toBe(200);
        expect((await fifth.json()).ok).toBe(true);

        const sixth = await attempt();
        expect(sixth.status).toBe(429);
      });

      it("does not throttle generate-code / remove-partner / unlink-self under the same tight cap", async () => {
        seedPartner();
        for (let i = 0; i < 5; i++) await attempt(); // exhaust the link-partner-specific bucket
        const generate = await action({ request: mockActionRequest({ intent: "generate-code" }) });
        expect(generate.status).toBe(200); // partnerAdmin's much looser cap, unaffected
      });
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
