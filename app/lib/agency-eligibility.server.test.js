import { describe, it, expect, vi } from "vitest";
import {
  fetchShopOwnerEmail, refreshShopOwnerEmail, countMerchantStores, isAgencyEligible, checkAgencyEligibility,
} from "./agency-eligibility.server.js";

function fakePrisma(seedRows = []) {
  const rows = new Map(seedRows.map((r) => [r.shop, { uninstalledAt: null, shopOwnerEmail: null, ...r }]));
  return {
    shopPlan: {
      findUnique: vi.fn(async ({ where: { shop } }) => rows.get(shop) || null),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = rows.get(shop);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return row;
      }),
      count: vi.fn(async ({ where }) => {
        return [...rows.values()].filter((r) =>
          r.shopOwnerEmail === where.shopOwnerEmail && r.uninstalledAt === where.uninstalledAt,
        ).length;
      }),
    },
    __rows: rows,
  };
}

const SHOP = "dest-shop.myshopify.com";
const VERSION = "2025-10";

describe("fetchShopOwnerEmail", () => {
  it("returns the shop's contact email, trimmed and lowercased", async () => {
    const shopifyGraphql = vi.fn(async () => ({ shop: { email: "  Owner@Example.com  " } }));
    const email = await fetchShopOwnerEmail({ shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });
    expect(email).toBe("owner@example.com");
    expect(shopifyGraphql).toHaveBeenCalledWith(SHOP, "tok", expect.stringContaining("shop"), {}, VERSION);
  });

  it("returns null (never throws) when the GraphQL call fails", async () => {
    const shopifyGraphql = vi.fn(async () => { throw new Error("401 unauthorized"); });
    const email = await fetchShopOwnerEmail({ shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });
    expect(email).toBeNull();
  });

  it("returns null when the shop has no email on file", async () => {
    const shopifyGraphql = vi.fn(async () => ({ shop: { email: null } }));
    const email = await fetchShopOwnerEmail({ shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });
    expect(email).toBeNull();
  });
});

describe("refreshShopOwnerEmail", () => {
  it("persists the fetched email onto the shop's ShopPlan row", async () => {
    const prisma = fakePrisma([{ shop: SHOP, id: "p1" }]);
    const shopifyGraphql = vi.fn(async () => ({ shop: { email: "owner@example.com" } }));
    const email = await refreshShopOwnerEmail({ prisma, shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });
    expect(email).toBe("owner@example.com");
    expect(prisma.__rows.get(SHOP).shopOwnerEmail).toBe("owner@example.com");
  });

  it("leaves the stored email untouched when the fetch fails", async () => {
    const prisma = fakePrisma([{ shop: SHOP, id: "p1", shopOwnerEmail: "old@example.com" }]);
    const shopifyGraphql = vi.fn(async () => { throw new Error("boom"); });
    const email = await refreshShopOwnerEmail({ prisma, shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });
    expect(email).toBeNull();
    expect(prisma.__rows.get(SHOP).shopOwnerEmail).toBe("old@example.com");
  });
});

describe("countMerchantStores / isAgencyEligible", () => {
  it("counts distinct currently-installed stores sharing the same owner email, including the shop itself", async () => {
    const prisma = fakePrisma([
      { shop: "a.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "b.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "c.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "unrelated.myshopify.com", shopOwnerEmail: "someone-else@example.com" },
    ]);
    const count = await countMerchantStores({ prisma, email: "owner@example.com" });
    expect(count).toBe(3);
  });

  it("excludes stores that have been uninstalled", async () => {
    const prisma = fakePrisma([
      { shop: "a.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "b.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "c.myshopify.com", shopOwnerEmail: "owner@example.com", uninstalledAt: new Date() },
    ]);
    expect(await countMerchantStores({ prisma, email: "owner@example.com" })).toBe(2);
    expect(await isAgencyEligible({ prisma, email: "owner@example.com" })).toBe(false); // below AGENCY_MIN_STORES (3)
  });

  it("is eligible at exactly 3 stores, not before", async () => {
    const prisma = fakePrisma([
      { shop: "a.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "b.myshopify.com", shopOwnerEmail: "owner@example.com" },
    ]);
    expect(await isAgencyEligible({ prisma, email: "owner@example.com" })).toBe(false);

    prisma.__rows.set("c.myshopify.com", { shop: "c.myshopify.com", shopOwnerEmail: "owner@example.com", uninstalledAt: null });
    expect(await isAgencyEligible({ prisma, email: "owner@example.com" })).toBe(true);
  });

  it("treats a missing email as ineligible without querying the database", async () => {
    const prisma = fakePrisma();
    expect(await countMerchantStores({ prisma, email: null })).toBe(0);
    expect(await isAgencyEligible({ prisma, email: null })).toBe(false);
    expect(prisma.shopPlan.count).not.toHaveBeenCalled();
  });
});

describe("checkAgencyEligibility", () => {
  it("refreshes the email, then reports store count and eligibility together", async () => {
    const prisma = fakePrisma([
      { shop: SHOP, shopOwnerEmail: null },
      { shop: "b.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "c.myshopify.com", shopOwnerEmail: "owner@example.com" },
    ]);
    const shopifyGraphql = vi.fn(async () => ({ shop: { email: "owner@example.com" } }));

    const result = await checkAgencyEligibility({ prisma, shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });

    expect(result).toEqual({ email: "owner@example.com", storeCount: 3, eligible: true, minStores: 3 });
  });

  it("falls back to the previously-stored email when the live fetch fails, instead of going blank", async () => {
    const prisma = fakePrisma([
      { shop: SHOP, shopOwnerEmail: "owner@example.com" },
      { shop: "b.myshopify.com", shopOwnerEmail: "owner@example.com" },
      { shop: "c.myshopify.com", shopOwnerEmail: "owner@example.com" },
    ]);
    const shopifyGraphql = vi.fn(async () => { throw new Error("token expired"); });

    const result = await checkAgencyEligibility({ prisma, shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });

    expect(result.email).toBe("owner@example.com");
    expect(result.eligible).toBe(true);
  });

  it("reports ineligible with a null email when nothing is known yet and the fetch fails", async () => {
    const prisma = fakePrisma([{ shop: SHOP, shopOwnerEmail: null }]);
    const shopifyGraphql = vi.fn(async () => { throw new Error("token expired"); });

    const result = await checkAgencyEligibility({ prisma, shopifyGraphql, shop: SHOP, token: "tok", version: VERSION });

    expect(result).toEqual({ email: null, storeCount: 0, eligible: false, minStores: 3 });
  });
});
