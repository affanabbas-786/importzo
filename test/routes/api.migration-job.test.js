import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockActionRequest } from "../../app/lib/test-helpers.js";

const db = { jobs: [] };
const SHOP = "dest-shop.myshopify.com";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    transferSession: { findUnique: vi.fn(async () => null) },
    migrationJob: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => {
        const row = { id: `job-${db.jobs.length + 1}`, ...data };
        db.jobs.push(row);
        return row;
      }),
    },
  },
}));

const savedSourceStore = { value: null };
vi.mock("../../app/lib/safe-db", () => ({
  getSavedSourceStore: vi.fn(async () => savedSourceStore.value),
}));

const runMigrationWorkerMock = vi.fn(() => Promise.resolve());
vi.mock("../../app/lib/migration-worker.server", () => ({
  runMigrationWorker: (...args) => runMigrationWorkerMock(...args),
}));

import { action } from "../../app/routes/api.migration-job.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";

function marketsGraphqlResponse(markets) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: { markets: { nodes: markets } } }),
  };
}

function marketNode({ id, handle, name = handle, publicationIds = [] }) {
  return {
    id, name, handle, status: "ACTIVE", type: "REGULAR",
    currencySettings: { baseCurrency: { currencyCode: "USD" } },
    catalogs: { nodes: publicationIds.map((pid, i) => ({ id: `gid://shopify/MarketCatalog/${i}`, publication: { id: pid } })) },
  };
}

describe("api.migration-job action", () => {
  let originalEncryptionKey;

  beforeEach(() => {
    __resetRateLimitState();
    db.jobs = [];
    savedSourceStore.value = null;
    runMigrationWorkerMock.mockClear();
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
    global.fetch = vi.fn();
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    vi.restoreAllMocks();
  });

  it("creates a job with no market scope by default (unchanged baseline behavior)", async () => {
    const req = mockActionRequest({ sourceShop: "source-shop.myshopify.com", sourceToken: "shpat_abc", conflictMode: "skip" });
    const res = await action({ request: req });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(db.jobs[0]).toMatchObject({ sourceMarketId: null, sourceMarketHandle: null, sourceMarketPublicationIds: null });
    expect(runMigrationWorkerMock).toHaveBeenCalledWith(db.jobs[0].id);
  });

  it("resolves a selected market against the SOURCE store and snapshots its publication ids onto the job", async () => {
    global.fetch.mockResolvedValueOnce(marketsGraphqlResponse([
      marketNode({ id: "gid://shopify/Market/1", handle: "eu", publicationIds: ["gid://shopify/Publication/10", "gid://shopify/Publication/11"] }),
      marketNode({ id: "gid://shopify/Market/2", handle: "row", publicationIds: [] }),
    ]));

    const req = mockActionRequest({
      sourceShop: "source-shop.myshopify.com", sourceToken: "shpat_abc", conflictMode: "skip",
      marketId: "gid://shopify/Market/1",
    });
    const res = await action({ request: req });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(db.jobs[0].sourceMarketId).toBe("gid://shopify/Market/1");
    expect(db.jobs[0].sourceMarketHandle).toBe("eu");
    expect(JSON.parse(db.jobs[0].sourceMarketPublicationIds)).toEqual(["gid://shopify/Publication/10", "gid://shopify/Publication/11"]);

    // The markets query must run against the SOURCE store's credentials, not the destination's.
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("source-shop.myshopify.com");
    expect(opts.headers["X-Shopify-Access-Token"]).toBe("shpat_abc");
  });

  it("stores a null publication-id list for a market with no restricting catalog, rather than an empty-but-filtering array", async () => {
    global.fetch.mockResolvedValueOnce(marketsGraphqlResponse([
      marketNode({ id: "gid://shopify/Market/2", handle: "row", publicationIds: [] }),
    ]));
    const req = mockActionRequest({
      sourceShop: "source-shop.myshopify.com", sourceToken: "shpat_abc",
      marketId: "gid://shopify/Market/2",
    });
    const res = await action({ request: req });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(db.jobs[0].sourceMarketPublicationIds).toBeNull();
  });

  it("400s with an explanatory error when the selected market id doesn't exist on the source store", async () => {
    global.fetch.mockResolvedValueOnce(marketsGraphqlResponse([
      marketNode({ id: "gid://shopify/Market/1", handle: "eu" }),
    ]));
    const req = mockActionRequest({
      sourceShop: "source-shop.myshopify.com", sourceToken: "shpat_abc",
      marketId: "gid://shopify/Market/999",
    });
    const res = await action({ request: req });

    expect(res.status).toBe(400);
    expect(db.jobs).toHaveLength(0); // no job created on a market resolution failure
  });

  it("400s with an explanatory error, rather than silently ignoring the filter, when Markets can't be read from the source", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false, status: 403,
      text: async () => JSON.stringify({ errors: [{ message: "Access denied for markets field" }] }),
    });
    const req = mockActionRequest({
      sourceShop: "source-shop.myshopify.com", sourceToken: "shpat_abc",
      marketId: "gid://shopify/Market/1",
    });
    const res = await action({ request: req });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Markets/);
    expect(db.jobs).toHaveLength(0);
  });

  it("does not call the markets API at all when no marketId is supplied", async () => {
    const req = mockActionRequest({ sourceShop: "source-shop.myshopify.com", sourceToken: "shpat_abc" });
    await action({ request: req });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("400s when source credentials are missing (existing behavior, unaffected by the market change)", async () => {
    const req = mockActionRequest({});
    const res = await action({ request: req });
    expect(res.status).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const res = await action({ request: { method: "GET" } });
    expect(res.status).toBe(405);
  });
});
