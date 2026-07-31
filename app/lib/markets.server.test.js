import { describe, it, expect, vi } from "vitest";
import { listMarkets, findMarket, marketQueryFilter } from "./markets.server.js";

function marketNode({ id, name, handle, currencyCode = "USD", publicationIds = [] }) {
  return {
    id, name, handle, status: "ACTIVE", type: "REGULAR",
    currencySettings: { baseCurrency: { currencyCode } },
    catalogs: { nodes: publicationIds.map((pid, i) => ({ id: `gid://shopify/MarketCatalog/${i}`, publication: pid ? { id: pid } : null })) },
  };
}

describe("listMarkets", () => {
  it("annotates each market with its catalog publication ids and hasProductFilter", async () => {
    const shopifyGraphql = vi.fn(async () => ({
      markets: {
        nodes: [
          marketNode({ id: "gid://shopify/Market/1", name: "European Union", handle: "eu", publicationIds: ["gid://shopify/Publication/10"] }),
          marketNode({ id: "gid://shopify/Market/2", name: "Rest of World", handle: "row", publicationIds: [] }),
        ],
      },
    }));

    const result = await listMarkets({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "2025-10" });

    expect(result.ok).toBe(true);
    expect(result.markets).toHaveLength(2);
    expect(result.markets[0]).toMatchObject({ handle: "eu", currencyCode: "USD", hasProductFilter: true, publicationIds: ["gid://shopify/Publication/10"] });
    expect(result.markets[1]).toMatchObject({ handle: "row", hasProductFilter: false, publicationIds: [] });
  });

  it("treats a market with no catalog at all as having no product filter", async () => {
    const shopifyGraphql = vi.fn(async () => ({
      markets: { nodes: [{ id: "gid://shopify/Market/3", name: "No Catalog", handle: "no-catalog", status: "ACTIVE", type: "REGULAR", currencySettings: { baseCurrency: { currencyCode: "USD" } }, catalogs: { nodes: [] } }] },
    }));
    const result = await listMarkets({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "2025-10" });
    expect(result.markets[0].hasProductFilter).toBe(false);
  });

  it("degrades gracefully (ok:false, empty list) instead of throwing when the request fails", async () => {
    const shopifyGraphql = vi.fn(async () => { throw new Error("GraphQL errors: Access denied for markets field"); });
    const result = await listMarkets({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "2025-10" });
    expect(result.ok).toBe(false);
    expect(result.markets).toEqual([]);
    expect(result.error).toMatch(/Access denied/);
  });
});

describe("findMarket / marketQueryFilter", () => {
  const markets = [
    { id: "gid://shopify/Market/1", handle: "eu", publicationIds: ["gid://shopify/Publication/10", "gid://shopify/Publication/11"] },
    { id: "gid://shopify/Market/2", handle: "row", publicationIds: [] },
  ];

  it("finds a market by id", () => {
    expect(findMarket(markets, "gid://shopify/Market/1").handle).toBe("eu");
    expect(findMarket(markets, "gid://shopify/Market/999")).toBeNull();
  });

  it("builds a publication_ids query filter from numeric ids", () => {
    expect(marketQueryFilter(markets[0])).toBe("publication_ids:10,11");
  });

  it("returns null when the market has no restricting catalog", () => {
    expect(marketQueryFilter(markets[1])).toBeNull();
  });

  it("returns null for a missing market", () => {
    expect(marketQueryFilter(null)).toBeNull();
  });
});
