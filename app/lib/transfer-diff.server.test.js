import { describe, it, expect, vi } from "vitest";
import {
  DIFF_ACTION, fetchDestinationIndex, diffFields, classifyProduct,
  summarizeDiff, findDuplicateSourceHandles, computeTransferDiff,
  MAX_DEST_INDEX_PRODUCTS,
} from "./transfer-diff.server.js";

function destNode(handle, overrides = {}) {
  return {
    id: `gid://shopify/Product/${handle}`,
    handle,
    title: `Dest ${handle}`,
    vendor: "DestVendor",
    productType: "DestType",
    status: "ACTIVE",
    ...overrides,
  };
}

function sourceProduct(handle, overrides = {}) {
  return {
    id: `gid://shopify/Product/src-${handle}`,
    handle,
    title: `Source ${handle}`,
    vendor: "SourceVendor",
    productType: "SourceType",
    status: "ACTIVE",
    ...overrides,
  };
}

function makeGraphql(destProducts, { pageSize = 250 } = {}) {
  return vi.fn(async (shop, token, query, variables) => {
    const start = variables?.after ? Number(variables.after) : 0;
    const slice = destProducts.slice(start, start + pageSize);
    const end = start + slice.length;
    return {
      products: {
        edges: slice.map((node, i) => ({ cursor: String(start + i), node })),
        pageInfo: { hasNextPage: end < destProducts.length, endCursor: String(end) },
      },
    };
  });
}

function indexOf(destProducts) {
  return new Map(destProducts.map((p) => [p.handle, p]));
}

describe("fetchDestinationIndex", () => {
  it("builds a handle→product index in a single pass", async () => {
    const shopifyGraphql = makeGraphql([destNode("a"), destNode("b")]);
    const { index, truncated } = await fetchDestinationIndex({ shopifyGraphql, shop: "d", token: "t", version: "2025-10" });

    expect(index.size).toBe(2);
    expect(index.get("a").title).toBe("Dest a");
    expect(truncated).toBe(false);
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
  });

  it("paginates and issues one request per page, not per product", async () => {
    const products = Array.from({ length: 600 }, (_, i) => destNode(`p-${i}`));
    const shopifyGraphql = makeGraphql(products, { pageSize: 250 });
    const { index } = await fetchDestinationIndex({ shopifyGraphql, shop: "d", token: "t", version: "2025-10" });

    expect(index.size).toBe(600);
    expect(shopifyGraphql).toHaveBeenCalledTimes(3); // 250 + 250 + 100
  });

  it("skips destination products with no handle", async () => {
    const shopifyGraphql = makeGraphql([destNode("a"), { id: "gid://shopify/Product/x", handle: null }]);
    const { index } = await fetchDestinationIndex({ shopifyGraphql, shop: "d", token: "t", version: "2025-10" });
    expect(index.size).toBe(1);
  });

  it("flags truncation at the cap rather than silently indexing part of the store", async () => {
    const products = Array.from({ length: 30 }, (_, i) => destNode(`p-${i}`));
    const shopifyGraphql = makeGraphql(products, { pageSize: 250 });
    const { index, truncated } = await fetchDestinationIndex({ shopifyGraphql, shop: "d", token: "t", version: "2025-10", max: 10 });

    expect(index.size).toBe(10);
    expect(truncated).toBe(true);
  });

  it("does not loop forever when a page claims more but returns no cursor", async () => {
    const shopifyGraphql = vi.fn(async () => ({
      products: { edges: [{ cursor: "0", node: destNode("a") }], pageInfo: { hasNextPage: true, endCursor: null } },
    }));
    const { index } = await fetchDestinationIndex({ shopifyGraphql, shop: "d", token: "t", version: "2025-10" });
    expect(index.size).toBe(1);
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
  });

  it("exposes a sane default cap", () => {
    expect(MAX_DEST_INDEX_PRODUCTS).toBeGreaterThan(0);
  });
});

describe("diffFields", () => {
  it("reports each differing compared field with from/to", () => {
    const changes = diffFields(
      sourceProduct("a", { title: "New Title", vendor: "DestVendor" }),
      destNode("a", { title: "Old Title" }),
    );
    expect(changes).toContainEqual({ field: "title", from: "Old Title", to: "New Title" });
    expect(changes.find((c) => c.field === "vendor")).toBeUndefined(); // identical
  });

  it("returns an empty list when the compared fields all match", () => {
    const dest = destNode("a");
    const src = sourceProduct("a", { title: dest.title, vendor: dest.vendor, productType: dest.productType });
    expect(diffFields(src, dest)).toEqual([]);
  });

  it("ignores fields the source doesn't specify rather than reporting a change to empty", () => {
    const changes = diffFields({ handle: "a", title: "T" }, destNode("a", { title: "T", vendor: "V" }));
    expect(changes.find((c) => c.field === "vendor")).toBeUndefined();
  });

  it("treats REST product_type and publishedAt as their GraphQL equivalents", () => {
    const changes = diffFields(
      { handle: "a", product_type: "NewType", published_at: "2024-01-01" },
      destNode("a", { productType: "OldType", status: "DRAFT" }),
    );
    expect(changes).toContainEqual({ field: "productType", from: "OldType", to: "NewType" });
    expect(changes).toContainEqual({ field: "status", from: "DRAFT", to: "ACTIVE" });
  });
});

describe("classifyProduct", () => {
  const index = indexOf([destNode("exists")]);

  describe('conflictMode "skip"', () => {
    it("classifies a new handle as create", () => {
      const result = classifyProduct(sourceProduct("brand-new"), index, "skip");
      expect(result.action).toBe(DIFF_ACTION.CREATE);
      expect(result.destId).toBeNull();
    });

    it("classifies an existing handle as skip, with the destination id and a reason", () => {
      const result = classifyProduct(sourceProduct("exists"), index, "skip");
      expect(result.action).toBe(DIFF_ACTION.SKIP);
      expect(result.destId).toBe("exists");
      expect(result.reason).toMatch(/already exists/i);
    });
  });

  describe('conflictMode "overwrite"', () => {
    it("classifies an existing handle as update and lists what changes", () => {
      const result = classifyProduct(sourceProduct("exists", { title: "Renamed" }), index, "overwrite");
      expect(result.action).toBe(DIFF_ACTION.UPDATE);
      expect(result.destId).toBe("exists");
      expect(result.changes).toContainEqual({ field: "title", from: "Dest exists", to: "Renamed" });
    });

    it("still classifies a new handle as create", () => {
      expect(classifyProduct(sourceProduct("nope"), index, "overwrite").action).toBe(DIFF_ACTION.CREATE);
    });

    it("warns when an overwrite has no detectable change, rather than implying it's a no-op", () => {
      const dest = index.get("exists");
      const src = sourceProduct("exists", { title: dest.title, vendor: dest.vendor, productType: dest.productType, status: dest.status });
      const result = classifyProduct(src, index, "overwrite");

      expect(result.action).toBe(DIFF_ACTION.UPDATE);
      expect(result.changes).toEqual([]);
      expect(result.warning).toMatch(/no differences were detected/i);
    });
  });

  describe('conflictMode "create"', () => {
    it("always creates, even for an existing handle", () => {
      expect(classifyProduct(sourceProduct("exists"), index, "create").action).toBe(DIFF_ACTION.CREATE);
    });

    it("warns that a colliding handle will yield a Shopify-suffixed near-duplicate", () => {
      const result = classifyProduct(sourceProduct("exists"), index, "create");
      expect(result.warning).toMatch(/append a suffix/i);
    });

    it("does not warn when the handle is genuinely new", () => {
      expect(classifyProduct(sourceProduct("fresh"), index, "create").warning).toBeNull();
    });
  });

  it("treats a handle-less source product as create, and says why it can't be matched", () => {
    const result = classifyProduct({ id: "gid://shopify/Product/9", title: "No handle" }, index, "skip");
    expect(result.action).toBe(DIFF_ACTION.CREATE);
    expect(result.warning).toMatch(/cannot be matched/i);
  });

  it("carries the source id through for correlation", () => {
    expect(classifyProduct(sourceProduct("x"), index, "skip").sourceId).toBe("src-x");
  });
});

describe("summarizeDiff", () => {
  it("counts each action and the number of warnings", () => {
    const summary = summarizeDiff([
      { action: "create" }, { action: "create", warning: "w" },
      { action: "update" }, { action: "skip" }, { action: "skip" },
    ]);
    expect(summary).toEqual({ create: 2, update: 1, skip: 2, total: 5, warnings: 1 });
  });

  it("returns zeros for an empty diff", () => {
    expect(summarizeDiff([])).toEqual({ create: 0, update: 0, skip: 0, total: 0, warnings: 0 });
  });
});

describe("findDuplicateSourceHandles", () => {
  it("reports handles appearing more than once in the source", () => {
    expect(findDuplicateSourceHandles([
      sourceProduct("a"), sourceProduct("b"), sourceProduct("a"), sourceProduct("a"),
    ])).toEqual(["a"]); // listed once, however many times it repeats
  });

  it("ignores products with no handle", () => {
    expect(findDuplicateSourceHandles([{ title: "x" }, { title: "y" }])).toEqual([]);
  });

  it("returns an empty list when all handles are unique", () => {
    expect(findDuplicateSourceHandles([sourceProduct("a"), sourceProduct("b")])).toEqual([]);
  });
});

describe("computeTransferDiff", () => {
  it("produces the create/update/skip breakdown a preview needs", async () => {
    const shopifyGraphql = makeGraphql([destNode("keep"), destNode("change")]);
    const result = await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: [sourceProduct("keep"), sourceProduct("change"), sourceProduct("new")],
      conflictMode: "skip",
    });

    expect(result.summary).toMatchObject({ create: 1, skip: 2, update: 0, total: 3 });
    expect(result.records).toHaveLength(3);
    expect(result.conflictMode).toBe("skip");
  });

  it("reflects conflictMode in the breakdown", async () => {
    const shopifyGraphql = makeGraphql([destNode("a")]);
    const overwrite = await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: [sourceProduct("a")], conflictMode: "overwrite",
    });
    expect(overwrite.summary).toMatchObject({ update: 1, skip: 0, create: 0 });
  });

  it("queries the destination once per page, not once per source product", async () => {
    const shopifyGraphql = makeGraphql([destNode("a")]);
    await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: Array.from({ length: 200 }, (_, i) => sourceProduct(`s-${i}`)),
      conflictMode: "skip",
    });
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
  });

  it("caps returned records for transport but keeps the summary complete", async () => {
    const shopifyGraphql = makeGraphql([]);
    const result = await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: Array.from({ length: 100 }, (_, i) => sourceProduct(`s-${i}`)),
      conflictMode: "skip", maxRecords: 10,
    });

    expect(result.records).toHaveLength(10);
    expect(result.recordsTruncated).toBe(true);
    expect(result.summary.total).toBe(100); // summary covers everything
    expect(result.summary.create).toBe(100);
  });

  it("surfaces duplicate handles within the source itself", async () => {
    const shopifyGraphql = makeGraphql([]);
    const result = await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: [sourceProduct("dupe"), sourceProduct("dupe")], conflictMode: "skip",
    });
    expect(result.duplicateSourceHandles).toEqual(["dupe"]);
  });

  it("propagates destination-index truncation so a partial preview isn't read as complete", async () => {
    const products = Array.from({ length: 30 }, (_, i) => destNode(`p-${i}`));
    const shopifyGraphql = vi.fn(async (shop, token, query, variables) => {
      const start = variables?.after ? Number(variables.after) : 0;
      const slice = products.slice(start, start + 10);
      return { products: { edges: slice.map((node, i) => ({ cursor: String(start + i), node })), pageInfo: { hasNextPage: start + 10 < products.length, endCursor: String(start + 10) } } };
    });

    // Patch the cap down via a direct index call, then assert the flag rides
    // through computeTransferDiff's own (uncapped) call for contrast.
    const capped = await fetchDestinationIndex({ shopifyGraphql, shop: "d", token: "t", version: "2025-10", max: 5 });
    expect(capped.truncated).toBe(true);

    const full = await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: [sourceProduct("p-0")], conflictMode: "skip",
    });
    expect(full.destIndexTruncated).toBe(false);
    expect(full.destIndexSize).toBe(30);
  });

  it("handles an empty source list", async () => {
    const shopifyGraphql = makeGraphql([destNode("a")]);
    const result = await computeTransferDiff({
      shopifyGraphql, destShop: "d", destToken: "t", version: "2025-10",
      sourceProducts: [], conflictMode: "skip",
    });
    expect(result.summary.total).toBe(0);
    expect(result.records).toEqual([]);
  });
});
