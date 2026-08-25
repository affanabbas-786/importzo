import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

const mockCreate = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

// Phase 5: every inventory write now goes through usage.server.js's
// assertQuotaAvailable/recordUsageAndCheck, which read and write
// prisma.shopPlan. Modeled as an in-memory Map, cleared before every test
// (see the top-level beforeEach below).
const shopPlanRows = new Map();
vi.mock("../../app/db.server", () => ({
  default: {
    importJob: { create: (...args) => mockCreate(...args) },
    shopPlan: {
      upsert: vi.fn(async ({ where: { shop }, update, create }) => {
        const existing = shopPlanRows.get(shop);
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const row = {
          id: "plan-1", recordsUsed: 0, subscriptionId: null, subscriptionStatus: null,
          shopOwnerEmail: null, uninstalledAt: null, createdAt: new Date(), updatedAt: new Date(), ...create,
        };
        shopPlanRows.set(shop, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = shopPlanRows.get(shop);
        if (!row) throw new Error("Record to update not found.");
        const patch = { ...data };
        if (patch.recordsUsed && typeof patch.recordsUsed === "object" && "increment" in patch.recordsUsed) {
          patch.recordsUsed = (row.recordsUsed || 0) + patch.recordsUsed.increment;
        }
        Object.assign(row, patch);
        return { ...row };
      }),
    },
  },
}));

import { action, buildSkuSearchQuery } from "../../app/routes/app.inventory.jsx";

const DEST_SHOP = "dest-shop.myshopify.com";

function setShopPlan(data) {
  shopPlanRows.set(DEST_SHOP, {
    id: "plan-preset", shop: DEST_SHOP, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...data,
  });
}

beforeEach(() => {
  shopPlanRows.clear();
});

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

  it("passes changeFromQuantity: null and an idempotency key on the set-quantities call (API 2026-04 requirements)", async () => {
    fetchMock
      .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }]))
      .mockResolvedValueOnce(setQuantitiesResponse());
    const req = mockActionRequest({ items: JSON.stringify([{ sku: "SKU-1", quantity: "10" }]), fileName: "inv.csv" });
    await action({ request: req });

    // calls[0] = locations, calls[1] = variant lookup, calls[2] = the set-quantities write
    const [, setOpts] = fetchMock.mock.calls[2];
    const body = JSON.parse(setOpts.body);

    expect(body.query).toContain("@idempotent(key: $idempotencyKey)");
    expect(typeof body.variables.idempotencyKey).toBe("string");
    expect(body.variables.idempotencyKey.length).toBeGreaterThan(0);
    // Omitting changeFromQuantity entirely (rather than passing null) is not
    // equivalent on 2026-04 and fails at runtime — this pins the explicit
    // opt-out so it can't be silently dropped in a future edit.
    expect(body.variables.input.quantities[0]).toHaveProperty("changeFromQuantity", null);
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

  describe("plan usage limits", () => {
    it("refuses to import at all once the shop's monthly allowance is used up", async () => {
      setShopPlan({ tier: "free", recordsUsed: 250 });
      const req = mockActionRequest({ items: JSON.stringify([{ sku: "SKU-1", quantity: "10" }]), fileName: "inv.csv" });
      const result = await action({ request: req });

      expect(result.status).toBe("failed");
      expect(result.errorCount).toBe(1);
      expect(result.error).toMatch(/used all 250 records/i);
      expect(fetchMock).not.toHaveBeenCalled(); // short-circuited before even fetching locations
    });

    it("increments usage for each SKU actually updated, but not for a not_found SKU", async () => {
      fetchMock
        .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/1", sku: "FOUND", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }]))
        .mockResolvedValueOnce(setQuantitiesResponse());
      const items = [{ sku: "FOUND", quantity: "10" }, { sku: "MISSING", quantity: "5" }];
      const req = mockActionRequest({ items: JSON.stringify(items), fileName: "inv.csv" });
      const result = await action({ request: req });

      expect(result.updatedCount).toBe(1);
      expect(result.notFoundCount).toBe(1);
      expect(shopPlanRows.get(DEST_SHOP).recordsUsed).toBe(1);
    });

    it("stops updating further rows once the plan limit is reached mid-import", async () => {
      // 5 remaining (245 used of 250) matches WRITE_CONCURRENCY exactly, so
      // batch 1 (5 rows, launched concurrently before any can flip the
      // shared quota flag) lands exactly on the cap; batch 2 (2 more) only
      // starts once batch 1 has fully resolved.
      setShopPlan({ tier: "free", recordsUsed: 245 });
      const items = Array.from({ length: 7 }, (_, i) => ({ sku: `SKU-${i + 1}`, quantity: "1" }));
      fetchMock.mockResolvedValueOnce(variantsResponse(
        items.map((it, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: it.sku, inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}` } })),
      ));
      // 7 writes will be attempted (one per SKU that's found); only the
      // first 5 should actually be reached before the quota flag stops the rest.
      for (let i = 0; i < 7; i++) fetchMock.mockResolvedValueOnce(setQuantitiesResponse());

      const req = mockActionRequest({ items: JSON.stringify(items), fileName: "inv.csv" });
      const result = await action({ request: req });

      expect(shopPlanRows.get(DEST_SHOP).recordsUsed).toBe(250);
      expect(result.updatedCount).toBe(5);
      const quotaStopped = result.results.filter((r) => r.status === "error" && /plan limit reached/i.test(r.error));
      expect(quotaStopped).toHaveLength(2);
    });

    it("never blocks an unlimited (Pro) plan", async () => {
      setShopPlan({ tier: "pro", recordsUsed: 999999 });
      fetchMock
        .mockResolvedValueOnce(variantsResponse([{ id: "gid://shopify/ProductVariant/1", sku: "SKU-1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }]))
        .mockResolvedValueOnce(setQuantitiesResponse());
      const req = mockActionRequest({ items: JSON.stringify([{ sku: "SKU-1", quantity: "10" }]), fileName: "inv.csv" });
      const result = await action({ request: req });

      expect(result.updatedCount).toBe(1);
      expect(shopPlanRows.get(DEST_SHOP).recordsUsed).toBe(1000000);
    });
  });
});
