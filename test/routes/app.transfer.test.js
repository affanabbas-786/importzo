import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => {
  // Phase 5: every write-producing intent now goes through
  // usage.server.js's assertQuotaAvailable/recordUsageAndCheck, both of
  // which read/write prisma.shopPlan. Modeled here the same way the rest of
  // this fake models Prisma — an in-memory Map, exposed via
  // __getShopPlanRows so quota-specific tests can pre-seed or inspect a
  // shop's plan without needing a real database.
  const shopPlanRows = new Map();
  return {
    default: {
      transferSession: { findUnique: vi.fn() },
      sourceStore: { findUnique: vi.fn(), upsert: vi.fn() },
      importJob: { create: vi.fn() },
      shopPlan: {
        upsert: vi.fn(async ({ where: { shop }, update, create }) => {
          const existing = shopPlanRows.get(shop);
          if (existing) { Object.assign(existing, update); return { ...existing }; }
          const row = {
            id: "plan-1", recordsUsed: 0, aiCallsUsed: 0, subscriptionId: null, subscriptionStatus: null,
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
          if (patch.aiCallsUsed && typeof patch.aiCallsUsed === "object" && "increment" in patch.aiCallsUsed) {
            patch.aiCallsUsed = (row.aiCallsUsed || 0) + patch.aiCallsUsed.increment;
          }
          Object.assign(row, patch);
          return { ...row };
        }),
      },
      __getShopPlanRows: () => shopPlanRows,
    },
  };
});

const createAltTextGeneratorMock = vi.fn();
vi.mock("../../app/lib/alt-text.server", () => ({
  createAltTextGenerator: (...args) => createAltTextGeneratorMock(...args),
}));

const getAiIntegrationForUseMock = vi.fn();
vi.mock("../../app/lib/ai-settings.server", () => ({
  getAiIntegrationForUse: (...args) => getAiIntegrationForUseMock(...args),
}));

const detectSimilarProductsMock = vi.fn();
vi.mock("../../app/lib/ai-provider.server", () => ({
  detectSimilarProducts: (...args) => detectSimilarProductsMock(...args),
}));

import { action } from "../../app/routes/app.transfer.jsx";
import dbMock from "../../app/db.server";

const SOURCE_SHOP = "source-shop.myshopify.com";
const DEST_SHOP = "dest-shop.myshopify.com";

function setShopPlan(data) {
  dbMock.__getShopPlanRows().set(DEST_SHOP, {
    id: "plan-preset", shop: DEST_SHOP, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    aiCallsUsed: 0, aiUsagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...data,
  });
}

// Phase 5: the mocked db module (and its shopPlan Map) is shared across
// every describe block in this file. Every write-producing intent now
// touches it, so it must reset before EVERY test here, not just the ones in
// the "plan usage limits" block below — otherwise earlier describe blocks'
// product/page/file creations leak into later tests' usage counts.
beforeEach(() => {
  dbMock.__getShopPlanRows().clear();
});

const emptyEdges = (field) => jsonResponse({ data: { [field]: { edges: [], pageInfo: { hasNextPage: false } } } });

// Dispatches based on which shop the request targets and what the GraphQL
// query/mutation contains, so call ORDER doesn't need to be hand-scripted —
// robust regardless of how transferContentAndMedia sequences its sub-calls.
function makeContentTransferFetch({ sourceFiles = [], destExistingFilenames = [], fileCreateHandler } = {}) {
  return vi.fn(async (url, opts) => {
    const isSource = url.startsWith(`https://${SOURCE_SHOP}`);
    const isDest = url.startsWith(`https://${DEST_SHOP}`);
    const body = opts?.body ? JSON.parse(opts.body) : {};
    const query = body.query || "";

    if (query.includes("query StoreFiles")) {
      if (isSource) {
        return jsonResponse({
          data: {
            files: {
              // __typename defaults to GenericFile (the shape every
              // pre-existing test here assumes); a fixture can override it
              // (and supply `sources`) to model a Video/Model3d node instead
              // — see the video-source-selection regression tests below.
              edges: sourceFiles.map((f, i) => ({
                cursor: String(i),
                node: f.__typename && f.__typename !== "GenericFile"
                  ? { __typename: f.__typename, id: `gid://shopify/${f.__typename}/${i}`, alt: f.filename, fileStatus: "READY", sources: f.sources }
                  : { __typename: "GenericFile", id: `gid://shopify/GenericFile/${i}`, alt: f.filename, fileStatus: "READY", url: f.originalSource },
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      if (isDest) {
        return jsonResponse({
          data: {
            files: {
              edges: destExistingFilenames.map((filename, i) => ({
                cursor: String(i),
                node: { __typename: "GenericFile", id: `gid://shopify/GenericFile/dest-${i}`, alt: filename, fileStatus: "READY", url: `https://${DEST_SHOP}/cdn/shop/files/${filename}` },
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
    }

    if (query.includes("mutation fileCreate")) {
      if (fileCreateHandler) return fileCreateHandler(body);
      const files = (body.variables?.files || []).map((f, i) => ({ id: `gid://shopify/GenericFile/new-${i}`, fileStatus: "READY", alt: f.alt }));
      return jsonResponse({ data: { fileCreate: { files, userErrors: [] } } });
    }

    if (query.includes("query SourcePages")) return emptyEdges("pages");
    if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
    if (query.includes("query SourcePolicies")) return jsonResponse({ data: { shop: { shopPolicies: [] } } });
    if (query.includes("menus(first")) return emptyEdges("menus");

    return jsonResponse({ data: {} });
  });
}

// Generic metafields responder shared across the products/pages/blogs
// tests below — also doubles as the regression check for the resourceType
// off-by-one bug fixed in copyGraphqlMetafields (query field must be the
// lowercased resource type, e.g. "product"/"page", never a numeric ID).
function metafieldsFetchHandlers(seenResourceTypes) {
  return {
    handleMetafieldsQuery(query) {
      const match = query.match(/query Metafields\(\$id: ID!\) {\s*(\w+)\(id: \$id\)/);
      const resourceKey = match?.[1] || "unknown";
      seenResourceTypes.add(resourceKey);
      return jsonResponse({ data: { [resourceKey]: { metafields: { edges: [] } } } });
    },
    handleMetafieldsSet(body) {
      return jsonResponse({ data: { metafieldsSet: { metafields: (body.variables?.metafields || []).map((m) => ({ namespace: m.namespace, key: m.key })), userErrors: [] } } });
    },
  };
}

describe("app.transfer action — transfer-products (products, media, metafields)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeProductTransferFetch({ sourceProducts, existingByHandle = null, onProductCreate, onVariantsBulkCreate, onMetafieldsSet, sourceMetafields = [] } = {}) {
    const seenResourceTypes = new Set();
    const { handleMetafieldsQuery, handleMetafieldsSet } = metafieldsFetchHandlers(seenResourceTypes);
    const fetchFn = vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";

      if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: sourceProducts.length } } });
      if (query.includes("query SourceProducts")) return jsonResponse({ data: { products: { edges: sourceProducts.map((p) => ({ cursor: p.id, node: p })), pageInfo: { hasNextPage: false } } } });
      if (query.includes("query FindProduct")) return jsonResponse({ data: { products: { edges: existingByHandle ? [{ node: existingByHandle }] : [] } } });
      if (query.includes("mutation ProductVariantsBulkCreate")) {
        onVariantsBulkCreate?.(body.variables);
        return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: (body.variables?.variants || []).map((_, i) => ({ id: `gid://shopify/ProductVariant/new-${i}` })), userErrors: [] } } });
      }
      if (query.includes("mutation ProductCreate")) {
        onProductCreate?.(body.variables);
        const id = `gid://shopify/Product/new-${Math.floor(Math.random() * 1e9)}`;
        return jsonResponse({ data: { productCreate: { product: { id }, userErrors: [] } } });
      }
      if (query.includes("mutation ProductUpdate")) return jsonResponse({ data: { productUpdate: { product: { id: existingByHandle?.id }, userErrors: [] } } });
      if (query.includes("productCreateMedia")) return jsonResponse({ data: { productCreateMedia: { media: [], mediaUserErrors: [] } } });
      if (query.includes("query ProductMedia")) return jsonResponse({ data: { product: { media: { nodes: [] } } } });
      if (query.includes("query Metafields")) {
        if (sourceMetafields.length) {
          const match = query.match(/query Metafields\(\$id: ID!\) {\s*(\w+)\(id: \$id\)/);
          const resourceKey = match?.[1] || "product";
          seenResourceTypes.add(resourceKey);
          return jsonResponse({ data: { [resourceKey]: { metafields: { edges: sourceMetafields.map((m) => ({ node: m })) } } } });
        }
        return handleMetafieldsQuery(query);
      }
      if (query.includes("mutation MetafieldsSet")) {
        onMetafieldsSet?.(body.variables);
        return handleMetafieldsSet(body);
      }

      throw new Error(`Unexpected fetch in transfer-products test: ${query.slice(0, 100)}`);
    });
    fetchFn.__seenResourceTypes = seenResourceTypes;
    return fetchFn;
  }

  function sourceProduct(id, overrides = {}) {
    return {
      id: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `product-${id}`,
      descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", publishedAt: "2024-01-01",
      options: [], images: { edges: [] }, variants: { edges: [] },
      ...overrides,
    };
  }

  it("transfers all standalone products from the source store", async () => {
    global.fetch = makeProductTransferFetch({ sourceProducts: [sourceProduct(1), sourceProduct(2)] });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.transferred).toBe(2);
    expect(result.results.every((r) => r.status === "success")).toBe(true);
  });

  it("copies product metafields using the correct resource-type query field (regression for the off-by-one bug)", async () => {
    const fetchFn = makeProductTransferFetch({ sourceProducts: [sourceProduct(1)] });
    global.fetch = fetchFn;
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    await action({ request: req });

    expect(fetchFn.__seenResourceTypes.has("product")).toBe(true);
  });

  // Reported regression after the productCreate/productVariantsBulkCreate
  // split: metafields silently stopped copying. Reproduces the exact
  // scenario (a multi-variant product with a real metafield value) and
  // asserts metafieldsSet actually fires with the correct destination GID.
  it("copies a real metafield value to the newly created product after variants are created", async () => {
    let createdProductGid = null;
    let metafieldsSetVariables = null;
    global.fetch = makeProductTransferFetch({
      sourceProducts: [sourceProduct(1, {
        options: [{ name: "Color" }],
        variants: { edges: [{ node: { sku: "MUG-RED", price: "12.00", selectedOptions: [{ name: "Color", value: "Red" }] } }] },
      })],
      sourceMetafields: [{ namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field" }],
      onMetafieldsSet: (variables) => { metafieldsSetVariables = variables; },
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const res = await originalFetch(url, opts);
      if (body.query.includes("mutation ProductCreate")) {
        const json = await res.json();
        createdProductGid = json?.data?.productCreate?.product?.id || null;
      }
      return res;
    });

    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.results[0].status).toBe("success");
    expect(metafieldsSetVariables).not.toBeNull();
    expect(metafieldsSetVariables.metafields[0]).toMatchObject({
      namespace: "custom", key: "material", value: "Cotton",
      ownerId: createdProductGid, // attached to the newly created destination product, not the source
    });
  });

  // app.transfer.jsx's copyGraphqlMetafields already checked userErrors
  // correctly (unlike migration-worker.server.js's copyMetafields, which
  // silently discarded them entirely — see migration-worker.server.test.js).
  // This confirms a userErrors rejection is surfaced with enough detail
  // (Shopify's message + the exact payload sent) to debug in one look.
  it("surfaces metafieldsSet userErrors as a detailed warning including the payload sent", async () => {
    global.fetch = makeProductTransferFetch({
      sourceProducts: [sourceProduct(1)],
      sourceMetafields: [{ namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field" }],
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("mutation MetafieldsSet")) {
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

    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    // The product itself still succeeds — a metafield rejection is not fatal.
    expect(result.results[0].status).toBe("success");
    const warning = result.results[0].warnings.find((w) => w.includes("Metafields rejected"));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Value does not match expected type/);
    expect(warning).toMatch(/INVALID/);
    expect(warning).toMatch(/"namespace":"custom"/);
    expect(warning).toMatch(/"key":"material"/);
  });

  // Regression coverage for a production bug: productCreate used to receive
  // "options"/"variants" directly on ProductInput, which the pinned API
  // version rejects ("Field is not defined on ProductInput"). Asserts the
  // actual payloads sent for a multi-variant product use the corrected
  // two-mutation shape.
  it("creates a multi-variant product via productCreate(productOptions) + productVariantsBulkCreate, never a bare options/variants field", async () => {
    let productCreateVariables = null;
    let bulkCreateVariables = null;
    global.fetch = makeProductTransferFetch({
      sourceProducts: [sourceProduct(1, {
        options: [{ name: "Color" }],
        variants: {
          edges: [
            { node: { sku: "MUG-RED", price: "12.00", selectedOptions: [{ name: "Color", value: "Red" }] } },
            { node: { sku: "MUG-BLUE", price: "12.00", selectedOptions: [{ name: "Color", value: "Blue" }] } },
          ],
        },
      })],
      onProductCreate: (variables) => { productCreateVariables = variables; },
      onVariantsBulkCreate: (variables) => { bulkCreateVariables = variables; },
    });

    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.results[0].status).toBe("success");
    expect(productCreateVariables.product).not.toHaveProperty("options");
    expect(productCreateVariables.product).not.toHaveProperty("variants");
    expect(productCreateVariables.product.productOptions).toEqual([
      { name: "Color", values: [{ name: "Red" }, { name: "Blue" }] },
    ]);
    expect(bulkCreateVariables.strategy).toBe("REMOVE_STANDALONE_VARIANT");
    expect(bulkCreateVariables.variants).toHaveLength(2);
    expect(bulkCreateVariables.variants[0]).toMatchObject({
      price: "12.00",
      optionValues: [{ optionName: "Color", name: "Red" }],
      inventoryItem: { sku: "MUG-RED" },
    });
  });

  it("conflictMode=skip leaves an existing product untouched instead of duplicating it", async () => {
    const existing = { id: "gid://shopify/Product/existing-1", handle: "product-1" };
    global.fetch = makeProductTransferFetch({ sourceProducts: [sourceProduct(1)], existingByHandle: existing, conflictMode: "skip" });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "skip" });
    const result = await action({ request: req });

    expect(result.results[0].status).toBe("success");
    expect(result.results[0].warnings).toContain("Skipped — product already exists");
  });

  it("dry run reports what would transfer without creating anything", async () => {
    const fetchFn = makeProductTransferFetch({ sourceProducts: [sourceProduct(1), sourceProduct(2)] });
    global.fetch = fetchFn;
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    expect(result.transferred).toBe(2);
    expect(result.results.every((r) => r.status === "dry-run")).toBe(true);
    expect(fetchFn.mock.calls.some((c) => JSON.parse(c[1].body).query.includes("mutation ProductCreate"))).toBe(false);
  });
});

describe("app.transfer action — transfer-content (pages, menus, metafields)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a new page on the destination and copies its metafields with the correct resource-type field", async () => {
    const seenResourceTypes = new Set();
    const { handleMetafieldsQuery, handleMetafieldsSet } = metafieldsFetchHandlers(seenResourceTypes);
    global.fetch = vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("query StoreFiles")) return emptyEdges("files");
      if (query.includes("query SourcePages")) {
        return jsonResponse({ data: { pages: { edges: [{ node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us", body: "<p>Hi</p>", isPublished: true, publishedAt: "2024-01-01", templateSuffix: null } }] } } });
      }
      if (query.includes("query FindPage")) return jsonResponse({ data: { pages: { edges: [] } } }); // no existing page
      if (query.includes("mutation PageCreate")) return jsonResponse({ data: { pageCreate: { page: { id: "gid://shopify/Page/new-1" }, userErrors: [] } } });
      if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
      if (query.includes("query SourcePolicies")) return jsonResponse({ data: { shop: { shopPolicies: [] } } });
      if (query.includes("menus(first")) return emptyEdges("menus");
      if (query.includes("query Metafields")) return handleMetafieldsQuery(query);
      if (query.includes("mutation MetafieldsSet")) return handleMetafieldsSet(body);
      throw new Error(`Unexpected fetch in page-transfer test: ${query.slice(0, 100)}`);
    });

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const pageResult = result.results.find((r) => r.type === "page");
    expect(pageResult.status).toBe("success");
    expect(pageResult.newId).toBe("new-1");
    expect(seenResourceTypes.has("page")).toBe(true);
  });

  it("updates an existing page in place by handle instead of creating a duplicate", async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("query StoreFiles")) return emptyEdges("files");
      if (query.includes("query SourcePages")) {
        return jsonResponse({ data: { pages: { edges: [{ node: { id: "gid://shopify/Page/1", title: "About Us", handle: "about-us", body: "<p>Hi</p>", isPublished: true } }] } } });
      }
      if (query.includes("query FindPage")) return jsonResponse({ data: { pages: { edges: [{ node: { id: "gid://shopify/Page/existing-9", handle: "about-us", title: "About Us (old)" } }] } } });
      if (query.includes("mutation PageUpdate")) return jsonResponse({ data: { pageUpdate: { page: { id: "gid://shopify/Page/existing-9" }, userErrors: [] } } });
      if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
      if (query.includes("query SourcePolicies")) return jsonResponse({ data: { shop: { shopPolicies: [] } } });
      if (query.includes("menus(first")) return emptyEdges("menus");
      if (query.includes("query Metafields")) return jsonResponse({ data: { page: { metafields: { edges: [] } } } });
      throw new Error(`Unexpected fetch in page-update test: ${query.slice(0, 100)}`);
    });

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const pageResult = result.results.find((r) => r.type === "page");
    expect(pageResult.status).toBe("success");
    expect(pageResult.newId).toBe("existing-9");
    expect(pageResult.warnings).toContain("Updated existing page with same handle");
  });

  // ── Bug: hyphenated page handles duplicated on every re-run ──
  // "Contact" and "News" deduped correctly while "Your Privacy Choices" made
  // a new page each time. Two causes, pinned separately below.
  //
  // Cause 1: the search term was unquoted. In Shopify's search syntax `-`
  // separates tokens and a leading `-` negates one, so
  // `handle:your-privacy-choices` parses as "your" AND NOT "privacy" AND NOT
  // "choices" — a search that cannot match. Single-word handles have no
  // hyphen and were unaffected, which is exactly the split observed.
  function pageFetchMock({ sourcePage, existingPages = [], onFindQuery = () => {} }) {
    return vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("query StoreFiles")) return emptyEdges("files");
      if (query.includes("query SourcePages")) {
        return jsonResponse({ data: { pages: { edges: [{ node: sourcePage }] } } });
      }
      if (query.includes("query FindPage")) {
        onFindQuery(body.variables?.query || "");
        return jsonResponse({ data: { pages: { edges: existingPages.map((n) => ({ node: n })) } } });
      }
      if (query.includes("mutation PageCreate")) return jsonResponse({ data: { pageCreate: { page: { id: "gid://shopify/Page/created-1" }, userErrors: [] } } });
      if (query.includes("mutation PageUpdate")) return jsonResponse({ data: { pageUpdate: { page: { id: body.variables?.id?.split("/").pop() || "updated" }, userErrors: [] } } });
      if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
      if (query.includes("query SourcePolicies")) return jsonResponse({ data: { shop: { shopPolicies: [] } } });
      if (query.includes("menus(first")) return emptyEdges("menus");
      if (query.includes("query Metafields")) return jsonResponse({ data: { page: { metafields: { edges: [] } } } });
      if (query.includes("mutation MetafieldsSet")) return jsonResponse({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      throw new Error(`Unexpected fetch: ${query.slice(0, 100)}`);
    });
  }

  it("quotes the handle in the lookup so a hyphenated handle can match at all", async () => {
    let seenQuery = null;
    global.fetch = pageFetchMock({
      sourcePage: { id: "gid://shopify/Page/1", title: "Your Privacy Choices", handle: "your-privacy-choices", body: "<p>x</p>", isPublished: true },
      existingPages: [],
      onFindQuery: (q) => { seenQuery = q; },
    });

    await action({ request: mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" }) });

    expect(seenQuery).toBe('handle:"your-privacy-choices"');
  });

  it("re-uses an existing hyphenated-handle page instead of duplicating it", async () => {
    global.fetch = pageFetchMock({
      sourcePage: { id: "gid://shopify/Page/1", title: "Your Privacy Choices", handle: "your-privacy-choices", body: "<p>x</p>", isPublished: true },
      existingPages: [{ id: "gid://shopify/Page/existing-77", handle: "your-privacy-choices", title: "Your Privacy Choices" }],
    });

    const result = await action({ request: mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" }) });

    const page = result.results.find((r) => r.type === "page");
    expect(page.status).toBe("success");
    expect(page.warnings).toContain("Updated existing page with same handle");
    expect(page.newId).toBe("existing-77");
  });

  // Cause 2: the lookup received the RAW src.handle while the create derived
  // one from the title when src.handle was absent. A page with no handle of
  // its own was therefore looked up as `undefined` (instant null) and then
  // created under a title-derived handle — so it was never found on any
  // subsequent run, and duplicated every time.
  it("looks a handle-less source page up under the same handle it will be created with", async () => {
    let seenQuery = null;
    global.fetch = pageFetchMock({
      sourcePage: { id: "gid://shopify/Page/1", title: "Your Privacy Choices", handle: null, body: "<p>x</p>", isPublished: true },
      existingPages: [{ id: "gid://shopify/Page/existing-88", handle: "your-privacy-choices", title: "Your Privacy Choices" }],
      onFindQuery: (q) => { seenQuery = q; },
    });

    const result = await action({ request: mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" }) });

    expect(seenQuery).toBe('handle:"your-privacy-choices"');
    const page = result.results.find((r) => r.type === "page");
    expect(page.newId).toBe("existing-88");
    expect(page.warnings).toContain("Updated existing page with same handle");
  });

  // `query:` search is fuzzy and can return a different page. Treating a
  // near-miss as "already exists" would overwrite unrelated merchant content,
  // which is worse than creating a duplicate.
  it("ignores a fuzzy search hit whose handle does not actually match", async () => {
    global.fetch = pageFetchMock({
      sourcePage: { id: "gid://shopify/Page/1", title: "Privacy", handle: "privacy", body: "<p>x</p>", isPublished: true },
      existingPages: [{ id: "gid://shopify/Page/other-1", handle: "privacy-policy-archive", title: "Privacy Policy Archive" }],
    });

    const result = await action({ request: mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" }) });

    const page = result.results.find((r) => r.type === "page");
    expect(page.newId).toBe("created-1"); // created fresh, did NOT overwrite the other page
    expect(page.warnings).not.toContain("Updated existing page with same handle");
  });

  it("matches an existing page whose handle differs only in case", async () => {
    global.fetch = pageFetchMock({
      sourcePage: { id: "gid://shopify/Page/1", title: "Your Privacy Choices", handle: "Your-Privacy-Choices", body: "<p>x</p>", isPublished: true },
      existingPages: [{ id: "gid://shopify/Page/existing-99", handle: "your-privacy-choices", title: "Your Privacy Choices" }],
    });

    const result = await action({ request: mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" }) });

    expect(result.results.find((r) => r.type === "page").newId).toBe("existing-99");
  });

  it("filters out unsupported customer-account-page menu items instead of failing the whole menu", async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("query StoreFiles")) return emptyEdges("files");
      if (query.includes("query SourcePages")) return emptyEdges("pages");
      if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
      if (query.includes("query SourcePolicies")) return jsonResponse({ data: { shop: { shopPolicies: [] } } });
      if (query.includes("query Menus")) {
        return jsonResponse({
          data: {
            menus: {
              edges: [{
                cursor: "1",
                node: {
                  id: "gid://shopify/Menu/1", title: "Main menu", handle: "main-menu", isDefault: true,
                  items: [
                    { title: "Home", type: "FRONTPAGE", url: "/", tags: [], items: [] },
                    { title: "Account", type: "CUSTOMER_ACCOUNT_PAGE", url: "/account", tags: [], items: [] },
                  ],
                },
              }],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      if (query.includes("query TargetMenus")) return jsonResponse({ data: { menus: { edges: [] } } });
      if (query.includes("mutation CreateMenu")) {
        const items = body.variables.items;
        return jsonResponse({ data: { menuCreate: { menu: { id: "gid://shopify/Menu/new-1", handle: "main-menu" }, userErrors: [] } }, __itemsSent: items });
      }
      throw new Error(`Unexpected fetch in menu test: ${query.slice(0, 100)}`);
    });

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const menuResult = result.results.find((r) => r.type === "menus");
    expect(menuResult.status).toBe("success");
    expect(menuResult.copied ?? menuResult.total).toBe(1);
    const menuDetail = menuResult.results[0];
    expect(menuDetail.status).toBe("success");
    expect(menuDetail.warnings[0]).toMatch(/customer account pages/i);
  });
});

// Regression coverage for menu-link resolution: previously the source menu's
// raw type/url were forwarded to the destination verbatim, with nothing
// resolving them against what was actually created there. Two specific,
// fixable cases:
//   - SHOP_POLICY items are unresolvable BY CONSTRUCTION (Shopify policies
//     are read-only via API, so no real policy resource is ever created on
//     the destination) — these must be rewritten to point at the policy-page
//     substitute this app creates instead.
//   - COLLECTION items may point at a collection that was never transferred
//     because collections are a separate module/intent — flagged with a
//     clear warning rather than left silently broken.
describe("app.transfer action — transfer-content menu link resolution", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function menuLinkFetchMock({ collectionHandles = null, includeCollectionItem = true } = {}) {
    return vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("query StoreFiles")) return emptyEdges("files");
      if (query.includes("query SourcePages")) return emptyEdges("pages");
      if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
      if (query.includes("query SourcePolicies")) {
        return jsonResponse({
          data: {
            shop: {
              shopPolicies: [{
                id: "gid://shopify/ShopPolicy/1", title: "Refund Policy", body: "<p>Refunds within 30 days.</p>",
                type: "REFUND_POLICY", url: `https://${SOURCE_SHOP}/policies/refund-policy`,
              }],
            },
          },
        });
      }
      if (query.includes("query FindPage")) return jsonResponse({ data: { pages: { edges: [] } } }); // policy-page doesn't exist yet
      if (query.includes("mutation PageCreate")) return jsonResponse({ data: { pageCreate: { page: { id: "gid://shopify/Page/policy-1" }, userErrors: [] } } });
      if (query.includes("query Menus")) {
        const items = [
          { title: "Refund Policy", type: "SHOP_POLICY", url: "/policies/refund-policy", tags: [], items: [] },
        ];
        if (includeCollectionItem) {
          items.push({ title: "Summer Sale", type: "COLLECTION", url: "/collections/summer-sale", tags: [], items: [] });
        }
        return jsonResponse({
          data: {
            menus: {
              edges: [{ cursor: "1", node: { id: "gid://shopify/Menu/1", title: "Main menu", handle: "main-menu", isDefault: true, items } }],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      if (query.includes("query TargetMenus")) return jsonResponse({ data: { menus: { edges: [] } } });
      if (query.includes("query TargetCollectionHandles")) {
        return jsonResponse({
          data: {
            collections: {
              edges: (collectionHandles || []).map((handle, i) => ({ cursor: String(i), node: { handle } })),
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      if (query.includes("mutation CreateMenu")) {
        return jsonResponse({ data: { menuCreate: { menu: { id: "gid://shopify/Menu/new-1", handle: "main-menu" }, userErrors: [] } }, __itemsSent: body.variables.items });
      }
      throw new Error(`Unexpected fetch in menu-link-resolution test: ${query.slice(0, 100)}`);
    });
  }

  it("rewrites a SHOP_POLICY menu item to point at the policy-page it was actually copied as", async () => {
    const fetchSpy = menuLinkFetchMock({ collectionHandles: ["summer-sale"] });
    global.fetch = fetchSpy;

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    await action({ request: req });

    const createCall = fetchSpy.mock.calls.find((c) => {
      const b = c[1]?.body ? JSON.parse(c[1].body) : {};
      return (b.query || "").includes("mutation CreateMenu");
    });
    const submitted = JSON.parse(createCall[1].body).variables.items;
    const policyItem = submitted.find((it) => it.title === "Refund Policy");
    expect(policyItem.type).toBe("PAGE");
    expect(policyItem.url).toBe("/pages/policy-refund-policy");
  });

  it("flags (without crashing the transfer) a COLLECTION link whose collection doesn't exist on the destination yet", async () => {
    global.fetch = menuLinkFetchMock({ collectionHandles: [] }); // destination has no collections at all

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const menuResult = result.results.find((r) => r.type === "menus");
    expect(menuResult.status).toBe("success"); // still succeeds — a warning, not a failure
    const menuDetail = menuResult.results[0];
    expect(menuDetail.warnings.some((w) => /collection.*doesn't exist on the destination/i.test(w))).toBe(true);
  });

  it("does not flag a COLLECTION link whose collection already exists on the destination", async () => {
    global.fetch = menuLinkFetchMock({ collectionHandles: ["summer-sale"] });

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const menuDetail = result.results.find((r) => r.type === "menus").results[0];
    expect(menuDetail.warnings.some((w) => /collection/i.test(w))).toBe(false);
  });

  it("never queries target collections when no source menu links to one (zero extra API cost in the common case)", async () => {
    const fetchSpy = menuLinkFetchMock({ includeCollectionItem: false });
    global.fetch = fetchSpy;

    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    await action({ request: req });

    const calledCollectionHandles = fetchSpy.mock.calls.some((c) => {
      const b = c[1]?.body ? JSON.parse(c[1].body) : {};
      return (b.query || "").includes("query TargetCollectionHandles");
    });
    expect(calledCollectionHandles).toBe(false);
  });
});

describe("app.transfer action — transfer-content idempotency (file dedupe)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies files that don't yet exist on the destination", async () => {
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{ filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` }],
      destExistingFilenames: [],
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.total).toBe(1);
    expect(fileResult.copied).toBe(1);
    expect(fileResult.skipped).toBe(0);
  });

  it("skips files that already exist on the destination instead of duplicating them", async () => {
    global.fetch = makeContentTransferFetch({
      sourceFiles: [
        { filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` },
        { filename: "new-banner.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/new-banner.jpg` },
      ],
      destExistingFilenames: ["hero.jpg"], // already present on destination
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.total).toBe(2);
    expect(fileResult.skipped).toBe(1);
    expect(fileResult.copied).toBe(1); // only new-banner.jpg was actually created
  });

  it("re-running the same content transfer a second time skips everything (fully idempotent)", async () => {
    const sourceFiles = [{ filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` }];
    global.fetch = makeContentTransferFetch({ sourceFiles, destExistingFilenames: [] });
    const req1 = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const first = await action({ request: req1 });
    expect(first.results.find((r) => r.type === "files").copied).toBe(1);

    // Second run: destination now already has hero.jpg from the first run.
    global.fetch = makeContentTransferFetch({ sourceFiles, destExistingFilenames: ["hero.jpg"] });
    const req2 = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const second = await action({ request: req2 });
    const secondFiles = second.results.find((r) => r.type === "files");
    expect(secondFiles.copied).toBe(0);
    expect(secondFiles.skipped).toBe(1);
  });

  it("dry run never queries the destination store for files", async () => {
    const fetchSpy = makeContentTransferFetch({ sourceFiles: [{ filename: "a.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/a.jpg` }] });
    global.fetch = fetchSpy;
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.status).toBe("dry-run");
    expect(fetchSpy.mock.calls.some((c) => c[0].startsWith(`https://${DEST_SHOP}`))).toBe(false);
  });
});

// Regression coverage for the "Invalid video url" bug: fileNodeToOriginalSourceAndType
// used to take the FIRST https URL out of a Video node's sources[] regardless of
// format, which can select an HLS manifest (.m3u8 — a playlist of segment files,
// not one fetchable video) instead of an actual mp4 file. fileCreate's
// originalSource needs a single real file, so submitting the manifest is what
// produced Shopify's "Invalid video url" userError.
describe("app.transfer action — transfer-content video source selection", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the mp4-format source over an HLS manifest when both are present", async () => {
    let submittedFiles = null;
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{
        filename: "clip",
        __typename: "Video",
        sources: [
          { url: `https://${SOURCE_SHOP}/videos/clip.m3u8`, mimeType: "application/x-mpegURL", format: "m3u8" },
          { url: `https://${SOURCE_SHOP}/videos/clip.mp4`, mimeType: "video/mp4", format: "mp4" },
        ],
      }],
      fileCreateHandler: (body) => {
        submittedFiles = body.variables?.files;
        return jsonResponse({ data: { fileCreate: { files: [{ id: "gid://shopify/Video/new-1", fileStatus: "READY" }], userErrors: [] } } });
      },
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    expect(submittedFiles).toHaveLength(1);
    expect(submittedFiles[0].originalSource).toBe(`https://${SOURCE_SHOP}/videos/clip.mp4`);
    expect(submittedFiles[0].contentType).toBe("VIDEO");
    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.copied).toBe(1);
    expect(fileResult.warnings).toEqual([]);
  });

  it("skips (with a warning, not a submission) a video with only a manifest source and no real file", async () => {
    let fileCreateCalled = false;
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{
        filename: "clip",
        __typename: "Video",
        sources: [{ url: `https://${SOURCE_SHOP}/videos/clip.m3u8`, mimeType: "application/x-mpegURL", format: "m3u8" }],
      }],
      fileCreateHandler: (body) => {
        fileCreateCalled = true;
        return jsonResponse({ data: { fileCreate: { files: [], userErrors: [] } } });
      },
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    expect(fileCreateCalled).toBe(false); // never submitted a guess likely to fail
    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.total).toBe(0); // not counted as a transferable item at all
    expect(fileResult.warnings.some((w) => /no direct, single-file source/i.test(w))).toBe(true);
  });

  it("classifies contentType from the GraphQL node type, not by sniffing the URL", async () => {
    // A hash-based Shopify video CDN URL with no recognizable file extension —
    // exactly the case the old mediaContentTypeFromUrl(url) sniffing missed.
    let submittedFiles = null;
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{
        filename: "clip",
        __typename: "Video",
        sources: [{ url: `https://cdn.shopify.com/videos/c/vp/${"a".repeat(32)}/output`, mimeType: "video/mp4", format: "mp4" }],
      }],
      fileCreateHandler: (body) => {
        submittedFiles = body.variables?.files;
        return jsonResponse({ data: { fileCreate: { files: [{ id: "gid://shopify/Video/new-1", fileStatus: "READY" }], userErrors: [] } } });
      },
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    await action({ request: req });

    expect(submittedFiles[0].contentType).toBe("VIDEO");
  });
});

describe("app.transfer action — transfer-theme idempotency", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips theme creation when a theme with the same generated name already exists on the destination", async () => {
    global.fetch = vi.fn(async (url, opts) => {
      if (url.includes(`${SOURCE_SHOP}/admin/api/2025-10/themes/123/assets.json`) && !url.includes("asset[key]")) {
        return jsonResponse({ assets: [{ key: "layout/theme.liquid" }, { key: "config/settings_schema.json" }] });
      }
      if (opts?.body && JSON.parse(opts.body).query?.includes("shop { name }")) {
        return jsonResponse({ data: { shop: { name: "Source Shop" } } });
      }
      if (url === `https://${DEST_SHOP}/admin/api/2025-10/themes.json` && (!opts || opts.method === undefined)) {
        return jsonResponse({ themes: [{ id: 999, name: "My Theme (Transferred)" }] });
      }
      throw new Error(`Unexpected fetch in idempotency test: ${url}`);
    });

    const req = mockActionRequest({
      intent: "transfer-theme",
      sourceUrl: SOURCE_SHOP,
      sourceToken: "src-token",
      themeId: "123",
      themeName: "My Theme",
    });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.newThemeId).toBe(999);
    expect(result.message).toMatch(/already exists/i);
    // Phase 5: skipping because the theme already exists is not a new record.
    expect(dbMock.__getShopPlanRows().get(DEST_SHOP)?.recordsUsed || 0).toBe(0);
  });
});

// Phase 5 — billing: every write-producing intent enforces the shop's
// monthly plan limit. The underlying quota engine (rollover, limit math) is
// unit-tested in app/lib/usage.server.test.js; these tests cover the wiring
// into this route specifically — the pre-check gate, what counts as a
// record per intent, and the mid-transfer stop.
describe("app.transfer action — plan usage limits", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    dbMock.__getShopPlanRows().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sourceProduct(id, overrides = {}) {
    return {
      id: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `product-${id}`,
      descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", publishedAt: "2024-01-01",
      options: [], images: { edges: [] }, variants: { edges: [] },
      ...overrides,
    };
  }

  function makeProductTransferFetch(sourceProducts, { existingByHandle = null } = {}) {
    return vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: sourceProducts.length } } });
      if (query.includes("query SourceProducts")) return jsonResponse({ data: { products: { edges: sourceProducts.map((p) => ({ cursor: p.id, node: p })), pageInfo: { hasNextPage: false } } } });
      if (query.includes("query FindProduct")) return jsonResponse({ data: { products: { edges: existingByHandle ? [{ node: existingByHandle }] : [] } } });
      if (query.includes("mutation ProductVariantsBulkCreate")) return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: [], userErrors: [] } } });
      if (query.includes("mutation ProductCreate")) return jsonResponse({ data: { productCreate: { product: { id: `gid://shopify/Product/new-${Math.floor(Math.random() * 1e9)}` }, userErrors: [] } } });
      if (query.includes("mutation ProductUpdate")) return jsonResponse({ data: { productUpdate: { product: { id: existingByHandle?.id }, userErrors: [] } } });
      if (query.includes("productCreateMedia")) return jsonResponse({ data: { productCreateMedia: { media: [], mediaUserErrors: [] } } });
      if (query.includes("query ProductMedia")) return jsonResponse({ data: { product: { media: { nodes: [] } } } });
      if (query.includes("query Metafields")) return jsonResponse({ data: { product: { metafields: { edges: [] } } } });
      if (query.includes("mutation MetafieldsSet")) return jsonResponse({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      throw new Error(`Unexpected fetch in quota test: ${query.slice(0, 100)}`);
    });
  }

  it("refuses to start transfer-products at all once the shop's monthly allowance is used up", async () => {
    setShopPlan({ tier: "free", recordsUsed: 250 });
    global.fetch = vi.fn(async () => { throw new Error("must not reach Shopify"); });

    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/used all 250 records/i);
    expect(result.error).toMatch(/upgrade/i);
  });

  it("increments usage for each standalone product actually created", async () => {
    global.fetch = makeProductTransferFetch([sourceProduct(1), sourceProduct(2)]);
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(dbMock.__getShopPlanRows().get(DEST_SHOP).recordsUsed).toBe(2);
  });

  it("does not consume quota for a product skipped due to conflictMode=skip", async () => {
    const existing = { id: "gid://shopify/Product/existing-1", handle: "product-1" };
    global.fetch = makeProductTransferFetch([sourceProduct(1)], { existingByHandle: existing });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "skip" });
    await action({ request: req });

    expect(dbMock.__getShopPlanRows().get(DEST_SHOP)?.recordsUsed || 0).toBe(0);
  });

  it("stops creating further standalone products once the plan limit is reached mid-transfer", async () => {
    // 10 remaining (240 used of 250) exactly matches the batch size, so
    // batch 1 (10 products, all launched concurrently before any of them
    // can flip the shared quota flag) lands exactly on the cap; batch 2 (2
    // more) only starts once batch 1 has fully resolved.
    setShopPlan({ tier: "free", recordsUsed: 240 });
    const products = Array.from({ length: 12 }, (_, i) => sourceProduct(i + 1));
    global.fetch = makeProductTransferFetch(products);

    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(dbMock.__getShopPlanRows().get(DEST_SHOP).recordsUsed).toBe(250);
    const succeeded = result.results.filter((r) => r.status === "success");
    const quotaStopped = result.results.filter((r) => r.status === "error" && /plan limit reached/i.test(r.error));
    expect(succeeded).toHaveLength(10);
    expect(quotaStopped).toHaveLength(2);
  });

  it("counts the collection itself as a record, separately from the products transferred into it", async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("mutation CollectionCreate")) return jsonResponse({ data: { collectionCreate: { collection: { id: "gid://shopify/Collection/new-1" }, userErrors: [] } } });
      if (query.includes("query SourceCollectionProducts")) return jsonResponse({ data: { collection: { products: { edges: [{ cursor: "1", node: sourceProduct(1) }], pageInfo: { hasNextPage: false } } } } });
      // Shape matches the real CollectionAddProductsPayload (collection +
      // userErrors). It previously returned a `job` field that does not
      // exist on any API version, mirroring a bug in the query itself — so
      // the mock certified a call that always failed against real Shopify.
      if (query.includes("mutation CollectionAddProducts")) return jsonResponse({ data: { collectionAddProducts: { collection: { id: "gid://shopify/Collection/1" }, userErrors: [] } } });
      if (query.includes("query Metafields")) return jsonResponse({ data: { collection: { metafields: { edges: [] } }, product: { metafields: { edges: [] } } } });
      if (query.includes("mutation MetafieldsSet")) return jsonResponse({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      if (query.includes("mutation ProductCreate")) return jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } });
      if (query.includes("mutation ProductVariantsBulkCreate")) return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: [], userErrors: [] } } });
      if (query.includes("productCreateMedia")) return jsonResponse({ data: { productCreateMedia: { media: [], mediaUserErrors: [] } } });
      if (query.includes("query ProductMedia")) return jsonResponse({ data: { product: { media: { nodes: [] } } } });
      throw new Error(`Unexpected fetch: ${query.slice(0, 100)}`);
    });

    const collection = { id: "1", title: "Summer", type: "custom" };
    const req = mockActionRequest({ intent: "transfer", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", collection: JSON.stringify(collection), conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    // 1 collection + 1 product = 2 records.
    expect(dbMock.__getShopPlanRows().get(DEST_SHOP).recordsUsed).toBe(2);
  });

  it("counts pages/blogs/menus/files created by transfer-content in one batched increment", async () => {
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{ filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` }],
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    // Only the one file was actually created (pages/blogs/menus were empty).
    expect(dbMock.__getShopPlanRows().get(DEST_SHOP).recordsUsed).toBe(1);
  });

  it("does not record usage for a transfer-content dry run", async () => {
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{ filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` }],
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    await action({ request: req });

    expect(dbMock.__getShopPlanRows().get(DEST_SHOP)?.recordsUsed || 0).toBe(0);
  });

  it("never blocks an unlimited (Pro) plan, and does not stop mid-transfer", async () => {
    setShopPlan({ tier: "pro", recordsUsed: 500000 });
    const products = Array.from({ length: 5 }, (_, i) => sourceProduct(i + 1));
    global.fetch = makeProductTransferFetch(products);

    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.results.every((r) => r.status === "success")).toBe(true);
    expect(dbMock.__getShopPlanRows().get(DEST_SHOP).recordsUsed).toBe(500005);
  });
});

// Phase 6 — opt-in AI alt-text for images copied without any. The
// source-store's own alt text, when present, always wins; generation only
// fills in the gap. Covers createProductOnTarget's image-mapping fix.
describe("app.transfer action — AI alt-text (Phase 6)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    dbMock.__getShopPlanRows().clear();
    createAltTextGeneratorMock.mockReset().mockResolvedValue({ enabled: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sourceProduct(id, overrides = {}) {
    return {
      id: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `product-${id}`,
      descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", publishedAt: "2024-01-01",
      options: [], images: { edges: [] }, variants: { edges: [] },
      ...overrides,
    };
  }

  function makeProductTransferFetch(sourceProducts) {
    return vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: sourceProducts.length } } });
      if (query.includes("query SourceProducts")) return jsonResponse({ data: { products: { edges: sourceProducts.map((p) => ({ cursor: p.id, node: p })), pageInfo: { hasNextPage: false } } } });
      if (query.includes("query FindProduct")) return jsonResponse({ data: { products: { edges: [] } } });
      if (query.includes("mutation ProductVariantsBulkCreate")) return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: [], userErrors: [] } } });
      if (query.includes("mutation ProductCreate")) return jsonResponse({ data: { productCreate: { product: { id: `gid://shopify/Product/new-${Math.floor(Math.random() * 1e9)}` }, userErrors: [] } } });
      if (query.includes("productCreateMedia")) return jsonResponse({ data: { productCreateMedia: { media: [], mediaUserErrors: [] } } });
      if (query.includes("query ProductMedia")) return jsonResponse({ data: { product: { media: { nodes: [] } } } });
      if (query.includes("query Metafields")) return jsonResponse({ data: { product: { metafields: { edges: [] } } } });
      if (query.includes("mutation MetafieldsSet")) return jsonResponse({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
      throw new Error(`Unexpected fetch in alt-text test: ${query.slice(0, 100)}`);
    });
  }

  function findMediaCall(fetchFn) {
    return fetchFn.mock.calls.find(([, opts]) => JSON.parse(opts.body).query.includes("productCreateMedia"));
  }

  it("never creates a generator when the toggle is off", async () => {
    global.fetch = makeProductTransferFetch([sourceProduct(1, { images: { edges: [{ node: { url: "https://example.com/a.jpg", altText: null } }] } } )]);
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create", altTextAutoGenerate: "false" });
    await action({ request: req });
    expect(createAltTextGeneratorMock).not.toHaveBeenCalled();
  });

  it("generates alt text for an image that has none, using the source product's title/description", async () => {
    createAltTextGeneratorMock.mockResolvedValue({ enabled: true, generate: vi.fn(async () => "A red ceramic mug") });
    global.fetch = makeProductTransferFetch([
      sourceProduct(1, { title: "Red Mug", descriptionHtml: "Ceramic", images: { edges: [{ node: { url: "https://example.com/a.jpg", altText: null } }] } }),
    ]);
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create", altTextAutoGenerate: "true" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    const mediaCall = findMediaCall(global.fetch);
    const sentMedia = JSON.parse(mediaCall[1].body).variables.media;
    expect(sentMedia[0].alt).toBe("A red ceramic mug");
  });

  it("preserves the source store's own alt text and never calls the generator when every image already has one", async () => {
    createAltTextGeneratorMock.mockResolvedValue({ enabled: true, generate: vi.fn(async () => "should not be used") });
    global.fetch = makeProductTransferFetch([
      sourceProduct(1, { images: { edges: [{ node: { url: "https://example.com/a.jpg", altText: "Original alt text" } }] } }),
    ]);
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create", altTextAutoGenerate: "true" });
    await action({ request: req });

    const mediaCall = findMediaCall(global.fetch);
    const sentMedia = JSON.parse(mediaCall[1].body).variables.media;
    expect(sentMedia[0].alt).toBe("Original alt text");
    const gen = await createAltTextGeneratorMock.mock.results[0].value;
    expect(gen.generate).not.toHaveBeenCalled();
  });

  it("fills in only the images missing alt text, leaving existing alt text on others untouched", async () => {
    createAltTextGeneratorMock.mockResolvedValue({ enabled: true, generate: vi.fn(async () => "Generated alt") });
    global.fetch = makeProductTransferFetch([
      sourceProduct(1, { images: { edges: [
        { node: { url: "https://example.com/a.jpg", altText: "Has alt already" } },
        { node: { url: "https://example.com/b.jpg", altText: null } },
      ] } }),
    ]);
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create", altTextAutoGenerate: "true" });
    await action({ request: req });

    const mediaCall = findMediaCall(global.fetch);
    const sentMedia = JSON.parse(mediaCall[1].body).variables.media;
    expect(sentMedia.find((m) => m.originalSource.endsWith("a.jpg")).alt).toBe("Has alt already");
    expect(sentMedia.find((m) => m.originalSource.endsWith("b.jpg")).alt).toBe("Generated alt");
  });

  it("does not fail the transfer when the generator returns nothing (best-effort)", async () => {
    createAltTextGeneratorMock.mockResolvedValue({ enabled: true, generate: vi.fn(async () => null) });
    global.fetch = makeProductTransferFetch([
      sourceProduct(1, { images: { edges: [{ node: { url: "https://example.com/a.jpg", altText: null } }] } } ),
    ]);
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create", altTextAutoGenerate: "true" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    const mediaCall = findMediaCall(global.fetch);
    const sentMedia = JSON.parse(mediaCall[1].body).variables.media;
    expect(sentMedia[0].alt).toBeUndefined();
  });
});

// Phase 6 — fuzzy duplicate detection, dry-run preview only. Advisory: it
// never blocks or changes what a real (non-dry-run) transfer does — only
// annotates dry-run rows with `similarTo` for the merchant to see.
describe("app.transfer action — duplicate detection (Phase 6, dry-run only)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    dbMock.__getShopPlanRows().clear();
    getAiIntegrationForUseMock.mockReset().mockResolvedValue(null);
    detectSimilarProductsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sourceProduct(id, overrides = {}) {
    return {
      id: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `product-${id}`,
      descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", publishedAt: "2024-01-01",
      options: [], images: { edges: [] }, variants: { edges: [] },
      ...overrides,
    };
  }

  function makeDryRunFetch({ sourceProducts, existingTitles = [] }) {
    return vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: sourceProducts.length } } });
      if (query.includes("query SourceProducts")) return jsonResponse({ data: { products: { edges: sourceProducts.map((p) => ({ cursor: p.id, node: p })), pageInfo: { hasNextPage: false } } } });
      if (query.includes("query ExistingProductTitles")) return jsonResponse({ data: { products: { edges: existingTitles.map((title) => ({ node: { title } })) } } });
      throw new Error(`Unexpected fetch in duplicate-detection test: ${query.slice(0, 100)}`);
    });
  }

  it("never checks for duplicates when no AI integration is configured", async () => {
    global.fetch = makeDryRunFetch({ sourceProducts: [sourceProduct(1)], existingTitles: ["Product 1"] });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    expect(result.results.every((r) => !r.similarTo)).toBe(true);
    expect(detectSimilarProductsMock).not.toHaveBeenCalled();
  });

  it("flags a likely duplicate returned by the provider on the matching dry-run row", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    detectSimilarProductsMock.mockResolvedValue({ ok: true, matches: [{ incomingTitle: "Blue Tee", existingTitle: "Blue T-Shirt" }] });
    global.fetch = makeDryRunFetch({
      sourceProducts: [sourceProduct(1, { title: "Blue Tee" }), sourceProduct(2, { title: "Red Hat" })],
      existingTitles: ["Blue T-Shirt", "Green Scarf"],
    });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    const blueTee = result.results.find((r) => r.title === "Blue Tee");
    const redHat = result.results.find((r) => r.title === "Red Hat");
    expect(blueTee.similarTo).toBe("Blue T-Shirt");
    expect(redHat.similarTo).toBeUndefined();
  });

  it("never runs the check when the destination store has no products at all", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    global.fetch = makeDryRunFetch({ sourceProducts: [sourceProduct(1)], existingTitles: [] });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    await action({ request: req });

    expect(detectSimilarProductsMock).not.toHaveBeenCalled();
  });

  it("never blocks or fails the dry-run preview when the similarity check itself fails", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    detectSimilarProductsMock.mockResolvedValue({ ok: false, error: "provider outage" });
    global.fetch = makeDryRunFetch({ sourceProducts: [sourceProduct(1)], existingTitles: ["Product 1"] });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.results.every((r) => !r.similarTo)).toBe(true);
  });

  it("gates groq_builtin on tier/quota and records one shared call on success, distinct from a raised exception", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "groq_builtin", apiKey: "gsk", model: "llama-3.1-8b-instant" });
    detectSimilarProductsMock.mockResolvedValue({ ok: true, matches: [] });
    setShopPlan({ tier: "pro", aiCallsUsed: 3 });
    global.fetch = makeDryRunFetch({ sourceProducts: [sourceProduct(1)], existingTitles: ["Product 1"] });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    await action({ request: req });

    expect(dbMock.__getShopPlanRows().get(DEST_SHOP).aiCallsUsed).toBe(4);
  });

  it("skips the check for groq_builtin when the shared budget is exhausted, without erroring", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "groq_builtin", apiKey: "gsk", model: "llama-3.1-8b-instant" });
    setShopPlan({ tier: "pro", aiCallsUsed: 500 });
    global.fetch = makeDryRunFetch({ sourceProducts: [sourceProduct(1)], existingTitles: ["Product 1"] });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(detectSimilarProductsMock).not.toHaveBeenCalled();
  });

  it("never runs during a real (non-dry-run) transfer", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    global.fetch = vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("productsCount")) return jsonResponse({ data: { productsCount: { count: 1 } } });
      if (query.includes("query SourceProducts")) return jsonResponse({ data: { products: { edges: [{ cursor: "1", node: sourceProduct(1) }], pageInfo: { hasNextPage: false } } } });
      if (query.includes("query FindProduct")) return jsonResponse({ data: { products: { edges: [] } } });
      if (query.includes("mutation ProductCreate")) return jsonResponse({ data: { productCreate: { product: { id: "gid://shopify/Product/new-1" }, userErrors: [] } } });
      if (query.includes("productCreateMedia")) return jsonResponse({ data: { productCreateMedia: { media: [], mediaUserErrors: [] } } });
      if (query.includes("query ProductMedia")) return jsonResponse({ data: { product: { media: { nodes: [] } } } });
      if (query.includes("query Metafields")) return jsonResponse({ data: { product: { metafields: { edges: [] } } } });
      throw new Error(`Unexpected fetch: ${query.slice(0, 100)}`);
    });
    const req = mockActionRequest({ intent: "transfer-products", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", conflictMode: "create" });
    await action({ request: req });

    expect(detectSimilarProductsMock).not.toHaveBeenCalled();
    expect(getAiIntegrationForUseMock).not.toHaveBeenCalled();
  });
});

// Phase 4.2: Markets bundled into the connect/verify-connection responses
// that populate the transfer UI's sourceInfo, so the market dropdown has
// something to show without a separate round trip.
describe("app.transfer action — connect (Markets integration)", () => {
  let originalEncryptionKey;

  beforeEach(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    vi.restoreAllMocks();
  });

  function marketNode({ id, handle, publicationIds = [] }) {
    return {
      id, name: handle, handle, status: "ACTIVE", type: "REGULAR",
      currencySettings: { baseCurrency: { currencyCode: "EUR" } },
      catalogs: { nodes: publicationIds.map((pid, i) => ({ id: `gid://shopify/MarketCatalog/${i}`, publication: { id: pid } })) },
    };
  }

  function makeConnectFetch({ marketsResponse } = {}) {
    return vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("productsCount")) {
        return jsonResponse({ data: { shop: { name: "Source Shop", email: "s@example.com", plan: { displayName: "Basic" } }, productsCount: { count: 5 }, collectionsCount: { count: 2 } } });
      }
      if (url.includes("/themes.json")) return { ok: false };
      if (query.includes("query ListMarkets")) {
        if (marketsResponse === "error") return { ok: false, status: 403, text: async () => JSON.stringify({ errors: [{ message: "Access denied for markets field" }] }) };
        return jsonResponse({ data: { markets: { nodes: marketsResponse || [] } } });
      }
      return jsonResponse({ data: {} });
    });
  }

  it("includes markets in a successful connect response", async () => {
    global.fetch = makeConnectFetch({
      marketsResponse: [marketNode({ id: "gid://shopify/Market/1", handle: "eu", publicationIds: ["gid://shopify/Publication/10"] })],
    });
    const req = mockActionRequest({ intent: "connect", sourceUrl: SOURCE_SHOP, sourceToken: "shpat_abc" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.markets).toHaveLength(1);
    expect(result.markets[0]).toMatchObject({ handle: "eu", hasProductFilter: true });
  });

  it("still connects successfully when the Markets request fails (e.g. scope not yet granted)", async () => {
    global.fetch = makeConnectFetch({ marketsResponse: "error" });
    const req = mockActionRequest({ intent: "connect", sourceUrl: SOURCE_SHOP, sourceToken: "shpat_abc" });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.markets).toEqual([]);
  });
});
