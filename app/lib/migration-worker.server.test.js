import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse } from "./test-helpers.js";

// ── Fake Prisma: enough of MigrationJob + ProductMapping to drive the
//    worker and assert on final state, without touching a real DB. ──
function createFakePrisma(initialJob) {
  const jobs = new Map([[initialJob.id, { ...initialJob }]]);
  const mappings = [];

  return {
    migrationJob: {
      findUnique: vi.fn(async ({ where: { id } }) => jobs.get(id) || null),
      update: vi.fn(async ({ where: { id }, data }) => {
        const job = jobs.get(id);
        const next = { ...job };
        for (const [k, v] of Object.entries(data)) {
          next[k] = v && typeof v === "object" && "increment" in v ? (job[k] || 0) + v.increment : v;
        }
        jobs.set(id, next);
        return next;
      }),
    },
    productMapping: {
      findMany: vi.fn(async ({ where: { jobId, status } }) =>
        mappings.filter((m) => m.jobId === jobId && (!status || m.status === status)).map((m) => ({ ...m }))),
      upsert: vi.fn(async ({ where: { jobId_sourceProductId: { jobId, sourceProductId } }, create, update }) => {
        const existing = mappings.find((m) => m.jobId === jobId && m.sourceProductId === sourceProductId);
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const row = { ...create };
        mappings.push(row);
        return { ...row };
      }),
    },
    __getJob: (id) => jobs.get(id),
    __getMappings: () => mappings,
  };
}

let fakePrisma;

vi.mock("../db.server.js", () => ({
  get default() { return fakePrisma; },
}));

const { runMigrationWorker, isWorkerActive } = await import("./migration-worker.server.js");

const SOURCE_SHOP = "source-shop.myshopify.com";
const DEST_SHOP = "dest-shop.myshopify.com";

function baseJob(overrides = {}) {
  return {
    id: "job-1",
    shop: DEST_SHOP,
    sourceShop: SOURCE_SHOP,
    sourceToken: "src-token", // no ":" → decrypt() passes it through unchanged
    destToken: "dest-token",
    apiVersion: "2025-10",
    status: "PENDING",
    totalProducts: 0,
    processedProducts: 0,
    failedProducts: 0,
    lastCursor: null,
    conflictMode: "skip",
    errorLog: "[]",
    ...overrides,
  };
}

function productNode(id, { handle = `p-${id}`, title = `Product ${id}` } = {}) {
  return {
    id: `gid://shopify/Product/${id}`,
    title, handle,
    descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", publishedAt: "2024-01-01",
    giftCard: false,
    options: [],
    images: { edges: [] },
    variants: { edges: [] },
  };
}

function productsPageResponse(nodes, hasNextPage = false, endCursor = null) {
  return jsonResponse({ data: { products: { edges: nodes.map((n) => ({ cursor: n.id, node: n })), pageInfo: { hasNextPage, endCursor } } } });
}

const emptyMediaResponse = jsonResponse({ data: { product: { media: { nodes: [] } } } });
const emptyMetafieldsResponse = (resourceKey) => jsonResponse({ data: { [resourceKey]: { metafields: { edges: [] } } } });

function makeFetch({ productPages, findProductByHandleResult = null, productCreateHandler, metafieldsHandler } = {}) {
  let pageCallIndex = 0;
  return vi.fn(async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    const query = body.query || "";

    if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: productPages.flat().length } } });
    if (query.includes("query SourceProducts")) {
      const page = productPages[pageCallIndex] || { nodes: [], hasNextPage: false };
      pageCallIndex++;
      return productsPageResponse(page.nodes, page.hasNextPage, page.endCursor || null);
    }
    if (query.includes("query FindProduct")) {
      return jsonResponse({ data: { products: { edges: findProductByHandleResult ? [{ node: findProductByHandleResult }] : [] } } });
    }
    if (query.includes("mutation ProductCreate")) {
      if (productCreateHandler) return productCreateHandler(body);
      const id = Math.floor(Math.random() * 1e9);
      return jsonResponse({ data: { productCreate: { product: { id: `gid://shopify/Product/new-${id}` }, userErrors: [] } } });
    }
    if (query.includes("query ProductMedia")) return emptyMediaResponse;
    if (query.includes("query Metafields")) {
      // The query embeds the resource type as a literal field name, e.g. "product(id: $id)".
      const match = query.match(/query Metafields\(\$id: ID!\) {\s*(\w+)\(id: \$id\)/);
      const resourceKey = match?.[1] || "product";
      if (metafieldsHandler) return metafieldsHandler(query, resourceKey);
      return emptyMetafieldsResponse(resourceKey);
    }
    if (query.includes("mutation MetafieldsSet")) {
      return jsonResponse({ data: { metafieldsSet: { metafields: (body.variables?.metafields || []).map((m) => ({ namespace: m.namespace, key: m.key })), userErrors: [] } } });
    }
    throw new Error(`Unexpected fetch in migration-worker test: ${query.slice(0, 80)}`);
  });
}

describe("runMigrationWorker", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates every source product and marks the job COMPLETED", async () => {
    fakePrisma = createFakePrisma(baseJob());
    global.fetch = makeFetch({ productPages: [{ nodes: [productNode(1), productNode(2)], hasNextPage: false }] });

    await runMigrationWorker("job-1");

    const job = fakePrisma.__getJob("job-1");
    expect(job.status).toBe("COMPLETED");
    expect(job.processedProducts).toBe(2);
    expect(job.failedProducts).toBe(0);
    const mappings = fakePrisma.__getMappings();
    expect(mappings).toHaveLength(2);
    expect(mappings.every((m) => m.status === "DONE")).toBe(true);
  });

  it("is idempotent on resume: does not re-create products already marked DONE", async () => {
    fakePrisma = createFakePrisma(baseJob({ lastCursor: null }));
    // Pre-seed as if product 1 already succeeded in a prior run.
    fakePrisma.__getMappings().push({ jobId: "job-1", sourceProductId: "1", destProductId: "existing-1", status: "DONE" });

    let productCreateCalls = 0;
    global.fetch = makeFetch({
      productPages: [{ nodes: [productNode(1), productNode(2)], hasNextPage: false }],
      productCreateHandler: () => {
        productCreateCalls++;
        return jsonResponse({ data: { productCreate: { product: { id: `gid://shopify/Product/new-${productCreateCalls}` }, userErrors: [] } } });
      },
    });

    await runMigrationWorker("job-1");

    expect(productCreateCalls).toBe(1); // only product 2 was actually created
    const job = fakePrisma.__getJob("job-1");
    expect(job.status).toBe("COMPLETED");
    expect(job.processedProducts).toBe(1); // only the newly-processed one counted this run
    const mappings = fakePrisma.__getMappings();
    expect(mappings.find((m) => m.sourceProductId === "1").destProductId).toBe("existing-1"); // untouched
    expect(mappings.find((m) => m.sourceProductId === "2").status).toBe("DONE");
  });

  it("records a per-product failure without aborting the rest of the job", async () => {
    fakePrisma = createFakePrisma(baseJob());
    global.fetch = makeFetch({
      productPages: [{ nodes: [productNode(1), productNode(2)], hasNextPage: false }],
      productCreateHandler: (body) => {
        if (body.variables.input.handle === "p-1") {
          return jsonResponse({ data: { productCreate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } });
        }
        return jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-2" }, userErrors: [] } } });
      },
    });

    await runMigrationWorker("job-1");

    const job = fakePrisma.__getJob("job-1");
    expect(job.status).toBe("COMPLETED"); // the job as a whole still completes
    expect(job.processedProducts).toBe(1);
    expect(job.failedProducts).toBe(1);
    const errorLog = JSON.parse(job.errorLog);
    expect(errorLog[0].error).toMatch(/Title can't be blank/);
    const mappings = fakePrisma.__getMappings();
    expect(mappings.find((m) => m.sourceProductId === "1").status).toBe("FAILED");
    expect(mappings.find((m) => m.sourceProductId === "2").status).toBe("DONE");
  });

  it("marks the job FAILED if fetching a source product page errors", async () => {
    fakePrisma = createFakePrisma(baseJob());
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: 0 } } });
      if (body.query.includes("query SourceProducts")) return jsonResponse({}, { status: 500 });
      throw new Error("unexpected call");
    });

    await runMigrationWorker("job-1");

    const job = fakePrisma.__getJob("job-1");
    expect(job.status).toBe("FAILED");
    expect(job.errorLog).toMatch(/Fetch page failed/);
  });

  it("does not start a second concurrent worker for the same job", async () => {
    fakePrisma = createFakePrisma(baseJob());
    global.fetch = makeFetch({ productPages: [{ nodes: [productNode(1)], hasNextPage: false }] });

    const first = runMigrationWorker("job-1");
    expect(isWorkerActive("job-1")).toBe(true);
    const second = runMigrationWorker("job-1"); // should no-op immediately
    await Promise.all([first, second]);

    expect(isWorkerActive("job-1")).toBe(false);
    // Only one pass should have created the product.
    const mappings = fakePrisma.__getMappings();
    expect(mappings).toHaveLength(1);
  });

  it("copies metafields to the newly created product using the correct resource-type query field", async () => {
    fakePrisma = createFakePrisma(baseJob());
    let metafieldsQuerySeen = null;
    let metafieldsSetVariables = null;
    global.fetch = makeFetch({
      productPages: [{ nodes: [productNode(1)], hasNextPage: false }],
      metafieldsHandler: (query, resourceKey) => {
        metafieldsQuerySeen = resourceKey;
        return jsonResponse({ data: { [resourceKey]: { metafields: { edges: [{ node: { namespace: "custom", key: "care_instructions", value: "Cold wash", type: "single_line_text_field" } }] } } } });
      },
    });
    // Capture the metafieldsSet mutation call separately since makeFetch's
    // generic handler doesn't expose it directly.
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("mutation MetafieldsSet")) {
        metafieldsSetVariables = body.variables;
      }
      return originalFetch(url, opts);
    });

    await runMigrationWorker("job-1");

    // This is the regression check for the resourceType off-by-one bug:
    // the query must target the "product" field, not a numeric ID.
    expect(metafieldsQuerySeen).toBe("product");
    expect(metafieldsSetVariables.metafields[0]).toMatchObject({ namespace: "custom", key: "care_instructions", value: "Cold wash" });
  });

  it("resolves conflicts per conflictMode: skip leaves the existing product untouched", async () => {
    fakePrisma = createFakePrisma(baseJob({ conflictMode: "skip" }));
    let productCreateCalled = false;
    global.fetch = makeFetch({
      productPages: [{ nodes: [productNode(1, { handle: "existing-handle" })], hasNextPage: false }],
      findProductByHandleResult: { id: "gid://shopify/Product/existing-999", handle: "existing-handle" },
      productCreateHandler: () => { productCreateCalled = true; return jsonResponse({ data: {} }); },
    });

    await runMigrationWorker("job-1");

    expect(productCreateCalled).toBe(false);
    const mappings = fakePrisma.__getMappings();
    expect(mappings[0].destProductId).toBe("existing-999");
    expect(mappings[0].status).toBe("DONE");
  });
});
