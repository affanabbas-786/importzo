import { describe, it, expect, vi } from "vitest";
import {
  generatePairingCode, regeneratePairingCode, partnerCount, listLinkedPartners,
  linkPartner, unlinkPartner, cascadeRevokePartnerLinks,
} from "./partner-linking.server.js";

// Minimal in-memory fake covering exactly what this module touches:
// shopPlan.findUnique/update/count/findMany, and an interactive
// $transaction that runs its callback against the same store (SQLite
// serializes writers within a real transaction; this fake doesn't need to
// model that to test the CHECK-then-WRITE logic itself).
function fakePrisma(rows = {}) {
  const store = new Map(Object.entries(rows).map(([shop, row]) => [shop, { shop, ...row }]));

  function matches(row, where = {}) {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  function shopPlanModel() {
    return {
      findUnique: vi.fn(async ({ where: { shop } }) => (store.has(shop) ? { ...store.get(shop) } : null)),
      update: vi.fn(async ({ where: { shop }, data }) => {
        if (!store.has(shop)) throw new Error(`No ShopPlan row for ${shop}`);
        const next = { ...store.get(shop), ...data };
        store.set(shop, next);
        return { ...next };
      }),
      count: vi.fn(async ({ where }) => [...store.values()].filter((r) => matches(r, where)).length),
      findMany: vi.fn(async ({ where, select, orderBy } = {}) => {
        let rows = [...store.values()].filter((r) => matches(r, where));
        if (orderBy?.shop === "asc") rows = [...rows].sort((a, b) => a.shop.localeCompare(b.shop));
        if (select) {
          rows = rows.map((r) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k]])));
        }
        return rows;
      }),
    };
  }

  const prisma = { shopPlan: shopPlanModel() };
  prisma.$transaction = vi.fn(async (fn) => fn(prisma));
  return { prisma, store };
}

const FIFTEEN_MIN = 15 * 60 * 1000;

describe("generatePairingCode", () => {
  it("produces a 6-digit numeric code", () => {
    for (let i = 0; i < 20; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe("regeneratePairingCode", () => {
  it("sets a code with a 15-minute expiry", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": {} });
    const now = new Date("2026-09-01T12:00:00.000Z");
    const { code, expiresAt } = await regeneratePairingCode({ prisma, shop: "b.myshopify.com", now });
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt.getTime()).toBe(now.getTime() + FIFTEEN_MIN);
  });

  it("overwrites — and so immediately invalidates — a previous code", async () => {
    const { prisma, store } = fakePrisma({ "b.myshopify.com": { pairingCode: "111111", pairingCodeExpiresAt: new Date(Date.now() + FIFTEEN_MIN) } });
    await regeneratePairingCode({ prisma, shop: "b.myshopify.com" });
    expect(store.get("b.myshopify.com").pairingCode).not.toBe("111111");
  });

  it("retries on a unique-constraint collision rather than surfacing it", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": {} });
    const collision = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    let attempts = 0;
    prisma.shopPlan.update = vi.fn(async (args) => {
      attempts += 1;
      if (attempts < 3) throw collision;
      const next = { ...(await prisma.shopPlan.findUnique({ where: args.where })), ...args.data };
      return next;
    });
    const { code } = await regeneratePairingCode({ prisma, shop: "b.myshopify.com" });
    expect(code).toMatch(/^\d{6}$/);
    expect(attempts).toBe(3);
  });
});

describe("partnerCount / listLinkedPartners", () => {
  it("counts and lists only rows linked to this payer", async () => {
    const { prisma } = fakePrisma({
      "a.myshopify.com": {},
      "b1.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro" },
      "b2.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro" },
      "other-payer-partner.myshopify.com": { partnerLinkedTo: "someone-else.myshopify.com" },
    });
    expect(await partnerCount({ prisma, payerShop: "a.myshopify.com" })).toBe(2);
    const list = await listLinkedPartners({ prisma, payerShop: "a.myshopify.com" });
    expect(list.map((p) => p.shop)).toEqual(["b1.myshopify.com", "b2.myshopify.com"]);
  });

  it("flags a partner that also holds its own independently active subscription", async () => {
    const { prisma } = fakePrisma({
      "b.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionId: "gid://x", subscriptionStatus: "ACTIVE" },
    });
    const [partner] = await listLinkedPartners({ prisma, payerShop: "a.myshopify.com" });
    expect(partner.hasIndependentSubscription).toBe(true);
  });
});

describe("linkPartner", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const validCode = () => ({ pairingCode: "424242", pairingCodeExpiresAt: new Date(now.getTime() + 60_000) });

  it("rejects a Free-tier payer outright", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": validCode() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "free", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/upgrade to pro or agency/i);
  });

  it("enforces the Pro cap of 1 partner", async () => {
    const { prisma } = fakePrisma({
      "already-linked.myshopify.com": { partnerLinkedTo: "a.myshopify.com" },
      "b.myshopify.com": validCode(),
    });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/i);
  });

  it("enforces the Agency cap of 5 partners", async () => {
    const linkedAlready = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`p${i}.myshopify.com`, { partnerLinkedTo: "a.myshopify.com" }]),
    );
    const { prisma } = fakePrisma({ ...linkedAlready, "b.myshopify.com": validCode() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/i);
  });

  it("allows the 6th distinct partner slot to be denied but the 5th to succeed (boundary)", async () => {
    const linkedAlready = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`p${i}.myshopify.com`, { partnerLinkedTo: "a.myshopify.com" }]),
    );
    const { prisma } = fakePrisma({ ...linkedAlready, "b.myshopify.com": validCode() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(true);
  });

  it("rejects an expired pairing code", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": { pairingCode: "424242", pairingCodeExpiresAt: new Date(now.getTime() - 1000) } });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid or expired/i);
  });

  it("rejects a mismatched pairing code without revealing which check failed", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": validCode() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", pairingCode: "000000", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid or expired/i);
  });

  it("rejects a partner already linked to a different payer", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": { ...validCode(), partnerLinkedTo: "someone-else.myshopify.com" } });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already linked/i);
  });

  it("single-use: a code cannot be redeemed twice, even by a different would-be payer", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": validCode() });
    const first = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(first.ok).toBe(true);

    // Same store, same code — the first link already cleared the code, so
    // a replay reads as an invalid/expired code (the code check runs before
    // the already-linked check), not a distinguishable "already used" error.
    const second = await linkPartner({ prisma, payerShop: "c.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/invalid or expired/i);
  });

  it("on success: sets the partner to Pro / PARTNER_LINKED, clears the code, and normalizes a bare domain", async () => {
    const { prisma, store } = fakePrisma({ "b.myshopify.com": validCode() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b", pairingCode: "424242", now });
    expect(result.ok).toBe(true);
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBe("a.myshopify.com");
    expect(row.tier).toBe("pro");
    expect(row.subscriptionStatus).toBe("PARTNER_LINKED");
    expect(row.subscriptionId).toBeNull();
    expect(row.pairingCode).toBeNull();
    expect(row.pairingCodeExpiresAt).toBeNull();
  });

  it("warns instead of writing when the partner already holds its own active subscription", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": { ...validCode(), subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" },
    });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.error).toMatch(/already has an active pro subscription/i);
    // Nothing written.
    expect(store.get("b.myshopify.com").partnerLinkedTo).toBeUndefined();
  });

  it("confirmOverwrite links the slot without touching the partner's own tier/subscription", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": { ...validCode(), subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" },
    });
    const result = await linkPartner({
      prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com",
      pairingCode: "424242", confirmOverwrite: true, now,
    });
    expect(result.ok).toBe(true);
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBe("a.myshopify.com");
    expect(row.subscriptionId).toBe("gid://own-sub"); // untouched
    expect(row.subscriptionStatus).toBe("ACTIVE"); // untouched
  });

  it("rejects a store linking itself", async () => {
    const { prisma } = fakePrisma({ "a.myshopify.com": validCode() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "a.myshopify.com", pairingCode: "424242", now });
    expect(result.ok).toBe(false);
  });

  it("two sequential attempts against a 1-slot Pro payer: second is rejected once the cap is reached", async () => {
    const { prisma } = fakePrisma({
      "b1.myshopify.com": validCode(),
      "b2.myshopify.com": { pairingCode: "999999", pairingCodeExpiresAt: new Date(now.getTime() + 60_000) },
    });
    const first = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b1.myshopify.com", pairingCode: "424242", now });
    const second = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b2.myshopify.com", pairingCode: "999999", now });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/limit/i);
  });
});

describe("unlinkPartner", () => {
  it("reverts a plain partner-linked shop to Free", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED", subscriptionId: null },
    });
    const result = await unlinkPartner({ prisma, partnerShop: "b.myshopify.com" });
    expect(result).toEqual({ ok: true, reverted: true });
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBeNull();
    expect(row.tier).toBe("free");
    expect(row.subscriptionStatus).toBeNull();
    expect(row.subscriptionId).toBeNull();
  });

  it("leaves an independently-paying partner's own plan untouched, only clearing the link", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "ACTIVE", subscriptionId: "gid://own-sub" },
    });
    const result = await unlinkPartner({ prisma, partnerShop: "b.myshopify.com" });
    expect(result).toEqual({ ok: true, reverted: true });
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBeNull();
    expect(row.tier).toBe("pro"); // untouched
    expect(row.subscriptionStatus).toBe("ACTIVE"); // untouched
    expect(row.subscriptionId).toBe("gid://own-sub"); // untouched
  });

  it("is a no-op for a shop that isn't linked to anyone", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": { tier: "free" } });
    const result = await unlinkPartner({ prisma, partnerShop: "b.myshopify.com" });
    expect(result).toEqual({ ok: true, reverted: false });
  });
});

describe("cascadeRevokePartnerLinks", () => {
  it("reverts every partner linked to the payer", async () => {
    const { prisma, store } = fakePrisma({
      "b1.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED" },
      "b2.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED" },
      "unrelated.myshopify.com": { partnerLinkedTo: "someone-else.myshopify.com" },
    });
    const result = await cascadeRevokePartnerLinks({ prisma, payerShop: "a.myshopify.com" });
    expect(result).toEqual({ total: 2, reverted: 2, errors: [] });
    expect(store.get("b1.myshopify.com").tier).toBe("free");
    expect(store.get("b2.myshopify.com").tier).toBe("free");
    expect(store.get("unrelated.myshopify.com").partnerLinkedTo).toBe("someone-else.myshopify.com"); // untouched
  });

  it("keeps going past one row's failure (best-effort)", async () => {
    const { prisma, store } = fakePrisma({
      "b1.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED" },
      "b2.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED" },
    });
    const realUpdate = prisma.shopPlan.update;
    prisma.shopPlan.update = vi.fn(async (args) => {
      if (args.where.shop === "b1.myshopify.com") throw new Error("db locked");
      return realUpdate(args);
    });
    const result = await cascadeRevokePartnerLinks({ prisma, payerShop: "a.myshopify.com" });
    expect(result.total).toBe(2);
    expect(result.reverted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(store.get("b2.myshopify.com").tier).toBe("free"); // the other row still got reverted
  });
});
