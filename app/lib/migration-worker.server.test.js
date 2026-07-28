import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse } from "./test-helpers.js";

// ── Fake Prisma: enough of MigrationJob + ProductMapping + TransferLogEntry
//    to drive the worker and assert on final state, without touching a real DB.
//    TransferLogEntry must be modelled here: createLogBuffer deliberately
//    swallows write failures so logging can never abort a transfer, which
//    means a missing fake would let these tests pass while logging silently
//    did nothing. ──
function createFakePrisma(initialJob) {
  const jobs = new Map([[initialJob.id, { ...initialJob }]]);
  const mappings = [];
  const logEntries = [];

  return {
    transferLogEntry: {
      createMany: vi.fn(async ({ data }) => {
        logEntries.push(...data);
        return { count: data.length };
      }),
    },
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
    __getLogEntries: () => logEntries,
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

function productNode(id, { handle = `p-${id}`, title = `Product ${id}`, isGiftCard = false, variants = { edges: [] }, options = [] } = {}) {
  return {
    id: `gid://shopify/Product/${id}`,
    title, handle,
    descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", publishedAt: "2024-01-01",
    isGiftCard,
    options,
    images: { edges: [] },
    variants,
  };
}

function productsPageResponse(nodes, hasNextPage = false, endCursor = null) {
  return jsonResponse({ data: { products: { edges: nodes.map((n) => ({ cursor: n.id, node: n })), pageInfo: { hasNextPage, endCursor } } } });
}

const emptyMediaResponse = jsonResponse({ data: { product: { media: { nodes: [] } } } });
const emptyMetafieldsResponse = (resourceKey) => jsonResponse({ data: { [resourceKey]: { metafields: { edges: [] } } } });

function makeFetch({ productPages, findProductByHandleResult = null, productCreateHandler, productUpdateHandler, variantsBulkCreateHandler, metafieldsHandler, onSourceProductsQuery } = {}) {
  let pageCallIndex = 0;
  return vi.fn(async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    const query = body.query || "";

    if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: productPages.flat().length } } });
    if (query.includes("query SourceProducts")) {
      onSourceProductsQuery?.(query);
      const page = productPages[pageCallIndex] || { nodes: [], hasNextPage: false };
      pageCallIndex++;
      return productsPageResponse(page.nodes, page.hasNextPage, page.endCursor || null);
    }
    if (query.includes("query FindProduct")) {
      return jsonResponse({ data: { products: { edges: findProductByHandleResult ? [{ node: findProductByHandleResult }] : [] } } });
    }
    if (query.includes("mutation ProductVariantsBulkCreate")) {
      if (variantsBulkCreateHandler) return variantsBulkCreateHandler(body);
      return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: (body.variables?.variants || []).map((_, i) => ({ id: `gid://shopify/ProductVariant/new-${i}` })), userErrors: [] } } });
    }
    if (query.includes("mutation ProductCreate")) {
      if (productCreateHandler) return productCreateHandler(body);
      const id = Math.floor(Math.random() * 1e9);
      return jsonResponse({ data: { productCreate: { product: { id: `gid://shopify/Product/new-${id}` }, userErrors: [] } } });
    }
    if (query.includes("mutation ProductUpdate")) {
      if (productUpdateHandler) return productUpdateHandler(body);
      return jsonResponse({ data: { productUpdate: { product: { id: body.variables?.input?.id }, userErrors: [] } } });
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

  // Regression coverage for a production bug: productCreate used to receive
  // "options"/"variants" directly on ProductInput, which the pinned API
  // version rejects outright ("Field is not defined on ProductInput"). This
  // asserts the actual mutation payloads sent for a multi-variant product are
  // structured the corrected way: productCreate carries only productOptions,
  // and productVariantsBulkCreate carries the priced/SKU'd variants.
  it("creates a multi-variant product via productCreate(productOptions) + productVariantsBulkCreate, never a bare options/variants field", async () => {
    fakePrisma = createFakePrisma(baseJob());
    let createProductVariables = null;
    let bulkCreateVariables = null;
    global.fetch = makeFetch({
      productPages: [{
        nodes: [productNode(1, {
          options: [{ name: "Size" }],
          variants: {
            edges: [
              { node: { sku: "TEE-S", price: "19.99", taxable: true, inventoryPolicy: "DENY", inventoryItem: { measurement: { weight: { value: 0.2, unit: "KILOGRAMS" } }, requiresShipping: true }, selectedOptions: [{ name: "Size", value: "Small" }] } },
              { node: { sku: "TEE-M", price: "19.99", taxable: true, inventoryPolicy: "DENY", inventoryItem: { measurement: { weight: { value: 0.2, unit: "KILOGRAMS" } }, requiresShipping: true }, selectedOptions: [{ name: "Size", value: "Medium" }] } },
            ],
          },
        })],
        hasNextPage: false,
      }],
      productCreateHandler: (body) => {
        createProductVariables = body.variables;
        return jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } });
      },
      variantsBulkCreateHandler: (body) => {
        bulkCreateVariables = body.variables;
        return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: [{ id: "v1" }, { id: "v2" }], userErrors: [] } } });
      },
    });

    await runMigrationWorker("job-1");

    expect(createProductVariables.product).not.toHaveProperty("options");
    expect(createProductVariables.product).not.toHaveProperty("variants");
    expect(createProductVariables.product.productOptions).toEqual([
      { name: "Size", values: [{ name: "Small" }, { name: "Medium" }] },
    ]);

    expect(bulkCreateVariables.productId).toBe("gid://shopify/Product/new-1");
    expect(bulkCreateVariables.strategy).toBe("REMOVE_STANDALONE_VARIANT");
    expect(bulkCreateVariables.variants).toHaveLength(2);
    expect(bulkCreateVariables.variants[0]).toMatchObject({
      price: "19.99",
      optionValues: [{ optionName: "Size", name: "Small" }],
      inventoryItem: { sku: "TEE-S", requiresShipping: true, measurement: { weight: { value: 0.2, unit: "KILOGRAMS" } } },
    });

    const job = fakePrisma.__getJob("job-1");
    expect(job.status).toBe("COMPLETED");
    expect(job.processedProducts).toBe(1);
  });

  // Reported regression after the productCreate/productVariantsBulkCreate split:
  // metafields silently stopped copying to newly created products. Reproduces
  // the exact scenario (a product WITH variants AND a metafield) to check
  // whether copyMetafields still runs, and with the right destination GID.
  it("copies metafields after both productCreate and productVariantsBulkCreate succeed for a multi-variant product", async () => {
    fakePrisma = createFakePrisma(baseJob());
    let metafieldsQuerySeen = null;
    let metafieldsIdQueried = null;
    let metafieldsSetVariables = null;
    global.fetch = makeFetch({
      productPages: [{
        nodes: [productNode(1, {
          options: [{ name: "Color" }],
          variants: {
            edges: [
              { node: { sku: "MUG-RED", price: "12.00", selectedOptions: [{ name: "Color", value: "Red" }] } },
              { node: { sku: "MUG-BLUE", price: "12.00", selectedOptions: [{ name: "Color", value: "Blue" }] } },
            ],
          },
        })],
        hasNextPage: false,
      }],
      productCreateHandler: () => jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } }),
      variantsBulkCreateHandler: () => jsonResponse({ data: { productVariantsBulkCreate: { productVariants: [{ id: "v1" }, { id: "v2" }], userErrors: [] } } }),
      metafieldsHandler: (query, resourceKey) => {
        metafieldsQuerySeen = resourceKey;
        return jsonResponse({ data: { [resourceKey]: { metafields: { edges: [{ node: { namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field" } }] } } } });
      },
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("query Metafields")) metafieldsIdQueried = body.variables.id;
      if (body.query.includes("mutation MetafieldsSet")) metafieldsSetVariables = body.variables;
      return originalFetch(url, opts);
    });

    await runMigrationWorker("job-1");

    expect(metafieldsQuerySeen).toBe("product");
    expect(metafieldsIdQueried).toBe("gid://shopify/Product/1"); // source product
    expect(metafieldsSetVariables).not.toBeNull();
    expect(metafieldsSetVariables.metafields[0]).toMatchObject({
      ownerId: "gid://shopify/Product/new-1", // the newly created destination product
      namespace: "custom", key: "material", value: "Cotton",
    });
  });

  // Regression coverage for the real root cause of the reported "metafield
  // silently doesn't copy" bug: metafieldsSet returning a 200 OK with a
  // non-empty userErrors array (e.g. Shopify rejecting the value/type) was
  // never checked at all — shopifyGraphql only throws on HTTP/GraphQL-protocol
  // errors, so this was previously indistinguishable from success and never
  // even reached a console.warn.
  it("captures metafieldsSet userErrors into the job's errorLog instead of treating a 200 OK as success", async () => {
    fakePrisma = createFakePrisma(baseJob());
    global.fetch = makeFetch({
      productPages: [{ nodes: [productNode(1)], hasNextPage: false }],
      productCreateHandler: () => jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } }),
      metafieldsHandler: (query, resourceKey) =>
        jsonResponse({ data: { [resourceKey]: { metafields: { edges: [{ node: { namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field" } }] } } } }),
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("mutation MetafieldsSet")) {
        // A perfectly valid HTTP 200 response — no exception is thrown for this.
        return jsonResponse({
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ field: ["metafields", "0", "value"], message: "Value does not match expected type", code: "INVALID" }],
            },
          },
        });
      }
      return originalFetch(url, opts);
    });

    await runMigrationWorker("job-1");

    // The product itself must still succeed — a metafield rejection is not fatal.
    const job = fakePrisma.__getJob("job-1");
    expect(job.status).toBe("COMPLETED");
    expect(job.processedProducts).toBe(1);
    expect(job.failedProducts).toBe(0);
    const mappings = fakePrisma.__getMappings();
    expect(mappings[0].status).toBe("DONE");

    // But the metafield failure must be retrievable from the job record —
    // exactly what /api/migration-status/:jobId already exposes.
    const errorLog = JSON.parse(job.errorLog);
    const mfError = errorLog.find((e) => e.type === "metafield");
    expect(mfError).toBeDefined();
    expect(mfError.destId).toBe("new-1");
    expect(mfError.error).toMatch(/Value does not match expected type/);
    expect(mfError.error).toMatch(/INVALID/);
    expect(mfError.payload[0]).toMatchObject({ namespace: "custom", key: "material", type: "single_line_text_field", value: "Cotton" });
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
        if (body.variables.product.handle === "p-1") {
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

  // Regression coverage for a production bug: the source-product query used
  // to request Product.giftCard and ProductVariant.fulfillmentService, neither
  // of which exists on the pinned API version (2025-10) — verified directly
  // against shopify.dev's GraphQL reference. A single invalid field makes the
  // *entire* query fail to parse, so every page fetch failed and the whole
  // migration job aborted before transferring anything.
  describe("SourceProducts query field validity (regression for the giftCard/fulfillmentService bug)", () => {
    it("only requests fields that are valid on the pinned API version", async () => {
      fakePrisma = createFakePrisma(baseJob());
      let queryText = null;
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1)], hasNextPage: false }],
        onSourceProductsQuery: (query) => { queryText = query; },
      });

      await runMigrationWorker("job-1");

      expect(queryText).not.toBeNull();
      // Product has no "giftCard" field (only ProductInput does, for mutations) — isGiftCard is correct.
      expect(queryText).toMatch(/\bisGiftCard\b/);
      expect(queryText).not.toMatch(/\bgiftCard\b/);
      // ProductVariant.fulfillmentService was removed in API version 2022-10.
      expect(queryText).not.toMatch(/\bfulfillmentService\b/);
      // ProductVariant.requiresShipping moved onto InventoryItem — it must be
      // nested inside the same line/block as inventoryItem, not a sibling of
      // inventoryPolicy (where it used to incorrectly live).
      const inventoryItemLine = queryText.split("\n").find((l) => l.includes("inventoryItem {"));
      const inventoryPolicyLine = queryText.split("\n").find((l) => l.trim().startsWith("inventoryPolicy"));
      expect(inventoryItemLine).toContain("requiresShipping");
      expect(inventoryPolicyLine).not.toContain("requiresShipping");
    });

    it("refuses to transfer a gift card product, reading the corrected isGiftCard field", async () => {
      fakePrisma = createFakePrisma(baseJob());
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1, { isGiftCard: true })], hasNextPage: false }],
      });

      await runMigrationWorker("job-1");

      const job = fakePrisma.__getJob("job-1");
      expect(job.failedProducts).toBe(1);
      const errorLog = JSON.parse(job.errorLog);
      expect(errorLog[0].error).toMatch(/Gift card products cannot be transferred/);
    });

    it("reads requiresShipping from the InventoryItem sub-selection into the destination variant input", async () => {
      fakePrisma = createFakePrisma(baseJob());
      let bulkVariables = null;
      global.fetch = makeFetch({
        productPages: [{
          nodes: [productNode(1, {
            variants: {
              edges: [{
                node: {
                  title: "Default", sku: "SKU-1", price: "10.00", taxable: true,
                  inventoryItem: { measurement: { weight: { value: 1, unit: "KILOGRAMS" } }, requiresShipping: false },
                  inventoryPolicy: "DENY",
                  selectedOptions: [],
                },
              }],
            },
          })],
          hasNextPage: false,
        }],
        variantsBulkCreateHandler: (body) => {
          bulkVariables = body.variables;
          return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: [{ id: "gid://shopify/ProductVariant/new-1" }], userErrors: [] } } });
        },
      });

      await runMigrationWorker("job-1");

      expect(bulkVariables.variants[0].inventoryItem.requiresShipping).toBe(false);
    });
  });

  // ── Phase 2: granular per-record transfer log ──
  describe("detailed per-record transfer log", () => {
    it("writes a 'created' log entry per successfully created product", async () => {
      fakePrisma = createFakePrisma(baseJob());
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1), productNode(2)], hasNextPage: false }],
      });

      await runMigrationWorker("job-1");

      const productEntries = fakePrisma.__getLogEntries().filter((e) => e.entityType === "product");
      expect(productEntries).toHaveLength(2);
      expect(productEntries.every((e) => e.action === "created")).toBe(true);
      expect(productEntries.map((e) => e.sourceId).sort()).toEqual(["1", "2"]);
      expect(productEntries[0]).toMatchObject({ jobId: "job-1", shop: DEST_SHOP });
      expect(productEntries[0].destId).toBeTruthy();
    });

    it("records a skipped product as action 'skipped' with the reason, not as created", async () => {
      fakePrisma = createFakePrisma(baseJob({ conflictMode: "skip" }));
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1, { handle: "existing-handle" })], hasNextPage: false }],
        findProductByHandleResult: { id: "gid://shopify/Product/existing-999", handle: "existing-handle" },
      });

      await runMigrationWorker("job-1");

      const entry = fakePrisma.__getLogEntries().find((e) => e.entityType === "product");
      expect(entry.action).toBe("skipped");
      expect(entry.destId).toBe("existing-999");
      expect(entry.reason).toMatch(/already exists/i);
    });

    it("records an overwritten product as action 'updated'", async () => {
      fakePrisma = createFakePrisma(baseJob({ conflictMode: "overwrite" }));
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1, { handle: "existing-handle" })], hasNextPage: false }],
        findProductByHandleResult: { id: "gid://shopify/Product/existing-999", handle: "existing-handle" },
      });

      await runMigrationWorker("job-1");

      const entry = fakePrisma.__getLogEntries().find((e) => e.entityType === "product");
      expect(entry.action).toBe("updated");
      expect(entry.destId).toBe("existing-999");
    });

    it("records a failed product as action 'failed' with the failure reason", async () => {
      fakePrisma = createFakePrisma(baseJob());
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1)], hasNextPage: false }],
        productCreateHandler: () => jsonResponse({
          data: { productCreate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } },
        }),
      });

      await runMigrationWorker("job-1");

      const entry = fakePrisma.__getLogEntries().find((e) => e.entityType === "product");
      expect(entry.action).toBe("failed");
      expect(entry.reason).toMatch(/Title can't be blank/);
      expect(entry.destId).toBeNull();
    });

    it("logs a metafield rejection as its own failed entry alongside the successful product", async () => {
      fakePrisma = createFakePrisma(baseJob());
      global.fetch = makeFetch({
        productPages: [{ nodes: [productNode(1)], hasNextPage: false }],
        productCreateHandler: () => jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } }),
        metafieldsHandler: (query, resourceKey) => jsonResponse({
          data: { [resourceKey]: { metafields: { edges: [{ node: { namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field" } }] } } },
        }),
      });
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.query.includes("mutation MetafieldsSet")) {
          return jsonResponse({
            data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["value"], message: "Value does not match expected type", code: "INVALID" }] } },
          });
        }
        return originalFetch(url, opts);
      });

      await runMigrationWorker("job-1");

      const entries = fakePrisma.__getLogEntries();
      // The product itself still succeeded...
      expect(entries.find((e) => e.entityType === "product").action).toBe("created");
      // ...and the metafield failure is its own separately queryable record.
      const mfEntry = entries.find((e) => e.entityType === "metafield");
      expect(mfEntry.action).toBe("failed");
      expect(mfEntry.reason).toMatch(/Value does not match expected type/);
      expect(mfEntry.destId).toBe("new-1");
    });

    it("flushes buffered entries even when the job fails mid-run", async () => {
      fakePrisma = createFakePrisma(baseJob());
      let pageCalls = 0;
      global.fetch = vi.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const query = body.query || "";
        if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: 1 } } });
        if (query.includes("query SourceProducts")) {
          pageCalls++;
          // First page succeeds with one product; the second page fetch fails,
          // which marks the job FAILED and returns early.
          if (pageCalls === 1) {
            return jsonResponse({ data: { products: { edges: [{ cursor: "c1", node: productNode(1) }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } });
          }
          return jsonResponse({}, { status: 500 });
        }
        if (query.includes("query FindProduct")) return jsonResponse({ data: { products: { edges: [] } } });
        if (query.includes("mutation ProductCreate")) return jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } });
        if (query.includes("query ProductMedia")) return jsonResponse({ data: { product: { media: { nodes: [] } } } });
        if (query.includes("query Metafields")) return jsonResponse({ data: { product: { metafields: { edges: [] } } } });
        throw new Error(`unexpected: ${query.slice(0, 60)}`);
      });

      await runMigrationWorker("job-1");

      expect(fakePrisma.__getJob("job-1").status).toBe("FAILED");
      // The one product that DID transfer before the failure must still be in
      // the log — it hadn't reached the 50-entry flush threshold.
      const entry = fakePrisma.__getLogEntries().find((e) => e.entityType === "product");
      expect(entry).toBeDefined();
      expect(entry.action).toBe("created");
    });
  });
});
