import { describe, it, expect, vi } from "vitest";
import {
  partnerCount, listLinkedPartners, linkPartner, unlinkPartner,
  dismissPartnerLinkNotice, shouldShowPartnerLinkNotice, cascadeRevokePartnerLinks,
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

// An installed companion store, ready to be linked (has a ShopPlan row, not
// soft-uninstalled). Linking is now direct by domain — no pairing code.
const installed = (extra = {}) => ({ tier: "free", uninstalledAt: null, ...extra });

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

  it("flags a companion that also holds its own independently active subscription", async () => {
    const { prisma } = fakePrisma({
      "b.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionId: "gid://x", subscriptionStatus: "ACTIVE" },
    });
    const [partner] = await listLinkedPartners({ prisma, payerShop: "a.myshopify.com" });
    expect(partner.hasIndependentSubscription).toBe(true);
  });
});

describe("linkPartner", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("rejects a Free-tier payer outright", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": installed() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "free", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/upgrade to pro or agency/i);
  });

  it("rejects a companion that hasn't installed Importzo (no ShopPlan row)", async () => {
    const { prisma } = fakePrisma({});
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no store with importzo installed/i);
  });

  it("rejects a companion that has soft-uninstalled", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": installed({ uninstalledAt: new Date("2026-08-30") }) });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no store with importzo installed/i);
  });

  it("enforces the Pro cap of 1 companion", async () => {
    const { prisma } = fakePrisma({
      "already-linked.myshopify.com": { partnerLinkedTo: "a.myshopify.com" },
      "b.myshopify.com": installed(),
    });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/i);
  });

  it("enforces the Agency cap of 5 companions", async () => {
    const linkedAlready = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`p${i}.myshopify.com`, { partnerLinkedTo: "a.myshopify.com" }]),
    );
    const { prisma } = fakePrisma({ ...linkedAlready, "b.myshopify.com": installed() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/i);
  });

  it("allows the 5th companion slot to succeed (boundary)", async () => {
    const linkedAlready = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`p${i}.myshopify.com`, { partnerLinkedTo: "a.myshopify.com" }]),
    );
    const { prisma } = fakePrisma({ ...linkedAlready, "b.myshopify.com": installed() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(true);
  });

  it("rejects a companion already linked to a different payer", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": installed({ partnerLinkedTo: "someone-else.myshopify.com" }) });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already linked to another/i);
  });

  it("reports a companion already linked to THIS payer as a no-op error, not a duplicate link", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": installed({ partnerLinkedTo: "a.myshopify.com" }) });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already one of your companions/i);
  });

  it("on success: sets the companion to Pro / PARTNER_LINKED, arms the notice, and normalizes a bare domain", async () => {
    const { prisma, store } = fakePrisma({ "b.myshopify.com": installed({ partnerLinkNoticeDismissedAt: new Date("2020-01-01") }) });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b", now });
    expect(result.ok).toBe(true);
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBe("a.myshopify.com");
    expect(row.tier).toBe("pro");
    expect(row.subscriptionStatus).toBe("PARTNER_LINKED");
    expect(row.subscriptionId).toBeNull();
    // Notice re-armed so B's dashboard banner shows for this link.
    expect(row.partnerLinkNoticeDismissedAt).toBeNull();
  });

  it("warns instead of writing when the companion already holds its own active subscription", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": installed({ subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" }),
    });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com", now });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.error).toMatch(/already has its own active pro subscription/i);
    // Nothing written.
    expect(store.get("b.myshopify.com").partnerLinkedTo).toBeUndefined();
  });

  it("confirmOverwrite links the slot without touching the companion's own tier/subscription", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": installed({ subscriptionId: "gid://own-sub", subscriptionStatus: "ACTIVE", tier: "pro" }),
    });
    const result = await linkPartner({
      prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "b.myshopify.com",
      confirmOverwrite: true, now,
    });
    expect(result.ok).toBe(true);
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBe("a.myshopify.com");
    expect(row.subscriptionId).toBe("gid://own-sub"); // untouched
    expect(row.subscriptionStatus).toBe("ACTIVE"); // untouched
  });

  it("rejects a store linking itself", async () => {
    const { prisma } = fakePrisma({ "a.myshopify.com": installed() });
    const result = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "agency", partnerDomain: "a.myshopify.com", now });
    expect(result.ok).toBe(false);
  });

  it("two sequential attempts against a 1-slot Pro payer: second is rejected once the cap is reached", async () => {
    const { prisma } = fakePrisma({
      "b1.myshopify.com": installed(),
      "b2.myshopify.com": installed(),
    });
    const first = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b1.myshopify.com", now });
    const second = await linkPartner({ prisma, payerShop: "a.myshopify.com", payerTier: "pro", partnerDomain: "b2.myshopify.com", now });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/limit/i);
  });
});

describe("unlinkPartner", () => {
  it("reverts a plain companion shop to Free and clears the notice flag", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": { partnerLinkedTo: "a.myshopify.com", tier: "pro", subscriptionStatus: "PARTNER_LINKED", subscriptionId: null, partnerLinkNoticeDismissedAt: new Date() },
    });
    const result = await unlinkPartner({ prisma, partnerShop: "b.myshopify.com" });
    expect(result).toEqual({ ok: true, reverted: true });
    const row = store.get("b.myshopify.com");
    expect(row.partnerLinkedTo).toBeNull();
    expect(row.tier).toBe("free");
    expect(row.subscriptionStatus).toBeNull();
    expect(row.subscriptionId).toBeNull();
    expect(row.partnerLinkNoticeDismissedAt).toBeNull();
  });

  it("leaves an independently-paying companion's own plan untouched, only clearing the link", async () => {
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

describe("dismissPartnerLinkNotice / shouldShowPartnerLinkNotice", () => {
  it("shows the banner for a fresh companion link and hides it after dismissal", async () => {
    const { prisma, store } = fakePrisma({
      "b.myshopify.com": { partnerLinkedTo: "a.myshopify.com", subscriptionStatus: "PARTNER_LINKED", partnerLinkNoticeDismissedAt: null },
    });
    expect(shouldShowPartnerLinkNotice(store.get("b.myshopify.com"))).toBe(true);

    const now = new Date("2026-09-03T00:00:00.000Z");
    const result = await dismissPartnerLinkNotice({ prisma, shop: "b.myshopify.com", now });
    expect(result).toEqual({ ok: true, dismissed: true });
    expect(store.get("b.myshopify.com").partnerLinkNoticeDismissedAt).toEqual(now);
    expect(shouldShowPartnerLinkNotice(store.get("b.myshopify.com"))).toBe(false);
  });

  it("never shows for a store that isn't a companion, or one paying independently", () => {
    expect(shouldShowPartnerLinkNotice({ partnerLinkedTo: null })).toBe(false);
    expect(shouldShowPartnerLinkNotice({
      partnerLinkedTo: "a.myshopify.com", subscriptionStatus: "ACTIVE", partnerLinkNoticeDismissedAt: null,
    })).toBe(false);
  });

  it("dismiss is a no-op for a store that isn't linked", async () => {
    const { prisma } = fakePrisma({ "b.myshopify.com": { tier: "free" } });
    const result = await dismissPartnerLinkNotice({ prisma, shop: "b.myshopify.com" });
    expect(result).toEqual({ ok: true, dismissed: false });
  });
});

describe("cascadeRevokePartnerLinks", () => {
  it("reverts every companion linked to the payer", async () => {
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
