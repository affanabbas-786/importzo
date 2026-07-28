import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

const mockCreate = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: { importJob: { create: (...args) => mockCreate(...args) } },
}));

import { action, buildSkuSearchQuery } from "../../app/routes/app.inventory.jsx";

const locationsResponse = jsonResponse({ data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1", name: "Main Warehouse" } }] } } });

function variantsResponse(nodes) {
  return jsonResponse({ data: { productVariants: { edges: nodes.map((n) => ({ node: n })) } } });
}

function setQuantitiesResponse(errors = []) {
  return jsonResponse({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: { reason: "correction" }, userErrors: errors } } });
}

describe("buildSkuSearchQuery", () => {
  it("joins multiple SKUs with OR and quotes each value", () => {
    expect(buildSkuSearchQuery(["A-1", "B-2"])).toBe('sku:"A-1" OR sku:"B-2"');
  });

  it("escapes embedded double quotes", () => {
    expect(buildSkuSearchQuery(['A"1'])).toBe('sku:"A\\"1"');
  });
});

describe("app.inventory action", () => {
  let fetchMock;

  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce(locationsResponse); // first call is always the location fetch
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates inventory for a found SKU via a single batched lookup call", async () => {
    fetchMock
      .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }]))
      .mockResolvedValueOnce(setQuantitiesResponse());
    const req = mockActionRequest({ items: JSON.stringify([{ sku: "SKU-1", quantity: "10" }]), fileName: "inv.csv" });
    const result = await action({ request: req });

    expect(result.updatedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ row: 1, sku: "SKU-1", status: "updated", quantity: 10 });
    // locations + 1 batched lookup + 1 write = 3 calls total (not 1 lookup per row)
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports not_found for a SKU the batched lookup didn't return", async () => {
    fetchMock.mockResolvedValueOnce(variantsResponse([])); // batch lookup finds nothing
    const req = mockActionRequest({ items: JSON.stringify([{ sku: "MISSING", quantity: "5" }]), fileName: "inv.csv" });
    const result = await action({ request: req });

    expect(result.notFoundCount).toBe(1);
    expect(result.results[0].status).toBe("not_found");
  });

  it("batches multiple SKUs into a single lookup call and updates each independently", async () => {
    const items = [
      { sku: "A", quantity: "1" },
      { sku: "B", quantity: "2" },
      { sku: "C", quantity: "3" },
    ];
    fetchMock
      .mockResolvedValueOnce(variantsResponse([
        { id: "gid://shopify/ProductVariant/1", sku: "A", inventoryItem: { id: "gid://shopify/InventoryItem/1" } },
        { id: "gid://shopify/ProductVariant/2", sku: "B", inventoryItem: { id: "gid://shopify/InventoryItem/2" } },
        { id: "gid://shopify/ProductVariant/3", sku: "C", inventoryItem: { id: "gid://shopify/InventoryItem/3" } },
      ]))
      .mockResolvedValueOnce(setQuantitiesResponse())
      .mockResolvedValueOnce(setQuantitiesResponse())
      .mockResolvedValueOnce(setQuantitiesResponse());

    const req = mockActionRequest({ items: JSON.stringify(items), fileName: "inv.csv" });
    const result = await action({ request: req });

    expect(result.updatedCount).toBe(3);
    // Row order must be preserved even though writes run concurrently.
    expect(result.results.map((r) => r.sku)).toEqual(["A", "B", "C"]);
    // locations(1) + one batched lookup(1) + 3 writes = 5, not 1+3+3=7
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("falls back to per-item lookups if the batched lookup call fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 500 })) // batch lookup fails
      .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/9", sku: "X", inventoryItem: { id: "gid://shopify/InventoryItem/9" } }])) // fallback per-item lookup
      .mockResolvedValueOnce(setQuantitiesResponse());
    const req = mockActionRequest({ items: JSON.stringify([{ sku: "X", quantity: "7" }]), fileName: "inv.csv" });
    const result = await action({ request: req });

    expect(result.updatedCount).toBe(1);
    expect(result.results[0].status).toBe("updated");
  });

  it("reports a per-row error if inventorySetQuantities returns userErrors", async () => {
    fetchMock
      .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }]))
      .mockResolvedValueOnce(setQuantitiesResponse([{ field: ["quantities"], message: "Invalid location" }]));
    const req = mockActionRequest({ items: JSON.stringify([{ sku: "SKU-1", quantity: "10" }]), fileName: "inv.csv" });
    const result = await action({ request: req });

    expect(result.errorCount).toBe(1);
    expect(result.results[0].error).toMatch(/Invalid location/);
  });

  it("is idempotent by construction: re-running the same file sets the same absolute quantity, never duplicating", async () => {
    const runOnce = async () => {
      fetchMock
        .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }]))
        .mockResolvedValueOnce(setQuantitiesResponse());
      const req = mockActionRequest({ items: JSON.stringify([{ sku: "SKU-1", quantity: "42" }]), fileName: "inv.csv" });
      return action({ request: req });
    };

    const first = await runOnce();
    fetchMock.mockResolvedValueOnce(locationsResponse); // second run's location fetch
    const second = await runOnce();

    expect(first.updatedCount).toBe(1);
    expect(second.updatedCount).toBe(1);
    expect(first.results[0].quantity).toBe(second.results[0].quantity);
  });
});
