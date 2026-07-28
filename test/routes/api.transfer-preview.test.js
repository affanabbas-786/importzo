import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: { transferSession: { findUnique: vi.fn(async () => null) } },
}));

const savedSourceStore = { value: null };
vi.mock("../../app/lib/safe-db", () => ({
  getSavedSourceStore: vi.fn(async () => savedSourceStore.value),
}));

import { action } from "../../app/routes/api.transfer-preview.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";

const SOURCE_SHOP = "source-shop.myshopify.com";
const DEST_SHOP = "dest-shop.myshopify.com";

function node(handle, overrides = {}) {
  return {
    id: `gid://shopify/Product/${handle}`,
    handle,
    title: `Title ${handle}`,
    vendor: "V",
    productType: "T",
    status: "ACTIVE",
    ...overrides,
  };
}

// Routes source vs destination product queries by target shop.
function makeFetch({ sourceProducts = [], destProducts = [] } = {}) {
  return vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const query = body.query || "";
    const isSource = url.startsWith(`https://${SOURCE_SHOP}`);
    const items = isSource ? sourceProducts : destProducts;

    if (query.includes("PreviewSourceProducts") || query.includes("DestinationIndex")) {
      return jsonResponse({
        data: {
          products: {
            edges: items.map((n, i) => ({ cursor: String(i), node: n })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
  });
}

describe("api.transfer-preview", () => {
  beforeEach(() => {
    __resetRateLimitState();
    savedSourceStore.value = null;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a create/update/skip breakdown for the given conflictMode", async () => {
    global.fetch = makeFetch({
      sourceProducts: [node("keep"), node("brand-new")],
      destProducts: [node("keep")],
    });

    const response = await action({
      request: mockActionRequest({ sourceShop: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "skip" }),
    });
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.summary).toMatchObject({ create: 1, skip: 1, update: 0, total: 2 });
    expect(body.sourceShop).toBe(SOURCE_SHOP);
    expect(body.destShop).toBe(DEST_SHOP);
  });

  it("reports overwrites with the fields that would change", async () => {
    global.fetch = makeFetch({
      sourceProducts: [node("shared", { title: "New Title" })],
      destProducts: [node("shared", { title: "Old Title" })],
    });

    const response = await action({
      request: mockActionRequest({ sourceShop: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "overwrite" }),
    });
    const body = await response.json();

    expect(body.summary).toMatchObject({ update: 1, create: 0, skip: 0 });
    expect(body.records[0].changes).toContainEqual({ field: "title", from: "Old Title", to: "New Title" });
  });

  it("writes nothing to either store — preview is read-only", async () => {
    const fetchMock = makeFetch({ sourceProducts: [node("a")], destProducts: [] });
    global.fetch = fetchMock;

    await action({ request: mockActionRequest({ sourceShop: SOURCE_SHOP, sourceToken: "src-token" }) });

    const mutations = fetchMock.mock.calls
      .map((c) => JSON.parse(c[1].body).query || "")
      .filter((q) => q.includes("mutation"));
    expect(mutations).toEqual([]);
  });

  it("falls back to the saved source store when no credentials are supplied", async () => {
    savedSourceStore.value = { sourceUrl: SOURCE_SHOP, token: "saved-token" };
    global.fetch = makeFetch({ sourceProducts: [node("a")], destProducts: [] });

    const response = await action({ request: mockActionRequest({ conflictMode: "skip" }) });
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.sourceShop).toBe(SOURCE_SHOP);
  });

  it("400s when no source credentials can be resolved", async () => {
    const response = await action({ request: mockActionRequest({ conflictMode: "skip" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Missing source store credentials/);
  });

  it("normalizes a bare shop name to a myshopify domain", async () => {
    global.fetch = makeFetch({ sourceProducts: [], destProducts: [] });
    const response = await action({
      request: mockActionRequest({ sourceShop: "source-shop", sourceToken: "t" }),
    });
    expect((await response.json()).sourceShop).toBe("source-shop.myshopify.com");
  });

  it("surfaces duplicate handles within the source", async () => {
    global.fetch = makeFetch({ sourceProducts: [node("dupe"), node("dupe")], destProducts: [] });
    const response = await action({
      request: mockActionRequest({ sourceShop: SOURCE_SHOP, sourceToken: "t" }),
    });
    expect((await response.json()).duplicateSourceHandles).toEqual(["dupe"]);
  });

  it("returns 502 with the reason when the source is unreachable", async () => {
    global.fetch = vi.fn(async () => jsonResponse({}, { status: 401 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await action({
      request: mockActionRequest({ sourceShop: SOURCE_SHOP, sourceToken: "bad" }),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).ok).toBe(false);
  });

  it("rejects non-POST", async () => {
    const response = await action({ request: { method: "GET", formData: async () => new FormData() } });
    expect(response.status).toBe(405);
  });
});
