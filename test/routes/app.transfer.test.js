import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    transferSession: { findUnique: vi.fn() },
    sourceStore: { findUnique: vi.fn(), upsert: vi.fn() },
    importJob: { create: vi.fn() },
  },
}));

import { action } from "../../app/routes/app.transfer.jsx";

const SOURCE_SHOP = "source-shop.myshopify.com";
const DEST_SHOP = "dest-shop.myshopify.com";

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
              edges: sourceFiles.map((f, i) => ({
                cursor: String(i),
                node: { id: `gid://shopify/GenericFile/${i}`, alt: f.filename, fileStatus: "READY", url: f.originalSource },
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
                node: { id: `gid://shopify/GenericFile/dest-${i}`, alt: filename, fileStatus: "READY", url: `https://${DEST_SHOP}/cdn/shop/files/${filename}` },
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
  });
});
