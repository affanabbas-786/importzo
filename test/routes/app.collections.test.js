import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

const mockCreate = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

// Phase 5: every collection create now goes through
// usage.server.js's assertQuotaAvailable/recordUsageAndCheck, which read
// and write prisma.shopPlan. Modeled as an in-memory Map, cleared before
// every test (see the top-level beforeEach below) so usage from one test
// never leaks into the next.
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

import { action } from "../../app/routes/app.collections.jsx";

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

function collectionCreateResponse(id, errors = []) {
  return jsonResponse({ data: { collectionCreate: { collection: errors.length ? null : { id: `gid://shopify/Collection/${id}` }, userErrors: errors } } });
}

// Every collection with a title triggers an idempotency pre-check
// (`collections(query: "title:...")`) before creation. This is the
// "no existing collection found" response for that check.
const noExistingCollectionResponse = jsonResponse({ data: { collections: { edges: [] } } });

function existingCollectionResponse(id) {
  return jsonResponse({ data: { collections: { edges: [{ node: { id: `gid://shopify/Collection/${id}` } }] } } });
}

describe("app.collections action", () => {
  let fetchMock;

  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a custom collection", async () => {
    fetchMock
      .mockResolvedValueOnce(noExistingCollectionResponse)
      .mockResolvedValueOnce(collectionCreateResponse("1"));
    const req = mockActionRequest({ collections: JSON.stringify([{ title: "Summer" }]), fileName: "c.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "success", type: "custom", collectionId: "1" });
  });

  it("creates a smart collection with parsed rules", async () => {
    fetchMock
      .mockResolvedValueOnce(noExistingCollectionResponse)
      .mockResolvedValueOnce(collectionCreateResponse("2"));
    const req = mockActionRequest({
      collections: JSON.stringify([{ title: "Sale Items", collection_type: "smart", rules_column: "tag:equals:sale" }]),
      fileName: "c.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0].type).toBe("smart");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.variables.input.ruleSet.rules[0]).toMatchObject({ column: "TAG", relation: "EQUALS", condition: "sale" });
  });

  it("retries collection creation without the image if the image URL fails, marking it a warning-success", async () => {
    fetchMock
      .mockResolvedValueOnce(noExistingCollectionResponse)
      .mockResolvedValueOnce(jsonResponse({ data: { collectionCreate: { collection: null, userErrors: [{ message: "Image could not be processed" }] } } }))
      .mockResolvedValueOnce(collectionCreateResponse("3"));
    const req = mockActionRequest({
      collections: JSON.stringify([{ title: "Broken Image", image_url: "https://example.com/bad.jpg" }]),
      fileName: "c.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0].warning).toMatch(/without image/i);
  });

  it("reports an error row when creation fails for a non-image reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { collectionCreate: { collection: null, userErrors: [{ message: "Title can't be blank" }] } } }),
    );
    const req = mockActionRequest({ collections: JSON.stringify([{ title: "" }]), fileName: "c.csv" });
    const result = await action({ request: req });

    expect(result.errorCount).toBe(1);
    expect(result.results[0].status).toBe("error");
  });

  it("preserves row order across concurrent batches", async () => {
    // Each collection now makes two calls (existence-check + create), and
    // concurrent items interleave those calls in whatever order their
    // microtasks settle in — so the mock must respond based on the request
    // itself rather than a fixed FIFO queue of canned responses.
    fetchMock.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query?.includes("collections(first: 1")) return noExistingCollectionResponse;
      return collectionCreateResponse("created");
    });
    const collections = Array.from({ length: 9 }, (_, i) => ({ title: `Collection ${i + 1}` }));
    const req = mockActionRequest({ collections: JSON.stringify(collections), fileName: "c.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(9);
    expect(result.results.map((r) => r.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("retries on a 429 before creating the collection", async () => {
    fetchMock
      .mockResolvedValueOnce(noExistingCollectionResponse)
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(collectionCreateResponse("5"));
    const req = mockActionRequest({ collections: JSON.stringify([{ title: "Retried" }]), fileName: "c.csv" });
    const result = await action({ request: req });
    expect(result.successCount).toBe(1);
  });

  it("idempotency: skips creating a collection when one with the same title already exists", async () => {
    fetchMock.mockResolvedValueOnce(existingCollectionResponse("999"));
    const req = mockActionRequest({ collections: JSON.stringify([{ title: "Already There" }]), fileName: "c.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "success", collectionId: "999" });
    expect(result.results[0].warning).toMatch(/already exists/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the existence check — no collectionCreate call
  });

  describe("plan usage limits", () => {
    it("refuses to import at all once the shop's monthly allowance is used up", async () => {
      setShopPlan({ tier: "free", recordsUsed: 250 });
      const req = mockActionRequest({ collections: JSON.stringify([{ title: "Summer" }]), fileName: "c.csv" });
      const result = await action({ request: req });

      expect(result.status).toBe("failed");
      expect(result.errorCount).toBe(1);
      expect(result.results[0].error).toMatch(/used all 250 records/i);
      expect(fetchMock).not.toHaveBeenCalled(); // short-circuited before touching Shopify
    });

    it("increments usage for each collection actually created", async () => {
      fetchMock.mockImplementation(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.query?.includes("collections(first: 1")) return noExistingCollectionResponse;
        return collectionCreateResponse("created");
      });
      const collections = [{ title: "A" }, { title: "B" }];
      const req = mockActionRequest({ collections: JSON.stringify(collections), fileName: "c.csv" });
      await action({ request: req });

      expect(shopPlanRows.get(DEST_SHOP).recordsUsed).toBe(2);
    });

    it("does not consume quota for a collection skipped because it already exists", async () => {
      fetchMock.mockResolvedValueOnce(existingCollectionResponse("999"));
      const req = mockActionRequest({ collections: JSON.stringify([{ title: "Already There" }]), fileName: "c.csv" });
      await action({ request: req });

      expect(shopPlanRows.get(DEST_SHOP)?.recordsUsed || 0).toBe(0);
    });

    it("stops creating further collections once the plan limit is reached mid-import", async () => {
      // 5 remaining (245 used of 250) matches CONCURRENCY exactly, so batch 1
      // (5 collections, all launched concurrently before any can flip the
      // shared quota flag) lands exactly on the cap; batch 2 (2 more) only
      // starts once batch 1 has fully resolved.
      setShopPlan({ tier: "free", recordsUsed: 245 });
      fetchMock.mockImplementation(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.query?.includes("collections(first: 1")) return noExistingCollectionResponse;
        return collectionCreateResponse("created");
      });
      const collections = Array.from({ length: 7 }, (_, i) => ({ title: `Collection ${i + 1}` }));
      const req = mockActionRequest({ collections: JSON.stringify(collections), fileName: "c.csv" });
      const result = await action({ request: req });

      expect(shopPlanRows.get(DEST_SHOP).recordsUsed).toBe(250);
      expect(result.successCount).toBe(5);
      const quotaStopped = result.results.filter((r) => r.status === "error" && /plan limit reached/i.test(r.error));
      expect(quotaStopped).toHaveLength(2);
    });

    it("never blocks an unlimited (Pro) plan", async () => {
      setShopPlan({ tier: "pro", recordsUsed: 999999 });
      fetchMock.mockImplementation(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.query?.includes("collections(first: 1")) return noExistingCollectionResponse;
        return collectionCreateResponse("created");
      });
      const req = mockActionRequest({ collections: JSON.stringify([{ title: "Summer" }]), fileName: "c.csv" });
      const result = await action({ request: req });

      expect(result.successCount).toBe(1);
      expect(shopPlanRows.get(DEST_SHOP).recordsUsed).toBe(1000000);
    });
  });
});
