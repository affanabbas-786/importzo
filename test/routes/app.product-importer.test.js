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

import { action } from "../../app/routes/app.product-importer.jsx";

function productCreateResponse(id, errors = []) {
  return jsonResponse({ data: { productCreate: { product: errors.length ? null : { id: `gid://shopify/Product/${id}` }, userErrors: errors } } });
}

function variantsBulkCreateResponse(count, errors = []) {
  return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: errors.length ? [] : Array.from({ length: count }, (_, i) => ({ id: `gid://shopify/ProductVariant/${i}` })), userErrors: errors } } });
}

describe("app.product-importer action", () => {
  let fetchMock;

  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    // First call in every run is the default-location lookup.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a simple product and reports success", async () => {
    fetchMock.mockResolvedValueOnce(productCreateResponse("111"));
    const req = mockActionRequest({ products: JSON.stringify([{ title: "Basic Tee" }]), fileName: "p.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.results[0]).toMatchObject({ row: 1, title: "Basic Tee", status: "success", productId: "111" });
  });

  it("reports a failed row without aborting the whole import", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { productCreate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } }),
    );
    const req = mockActionRequest({ products: JSON.stringify([{ title: "" }]), fileName: "p.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].error).toMatch(/Title can't be blank/);
  });

  it("attaches images via productCreateMedia after product creation", async () => {
    fetchMock
      .mockResolvedValueOnce(productCreateResponse("222"))
      .mockResolvedValueOnce(jsonResponse({ data: { productCreateMedia: { media: [{ id: "gid://shopify/MediaImage/1" }], mediaUserErrors: [] } } }));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "Mug", images: ["https://example.com/a.jpg"] }]),
      fileName: "p.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // location + productCreate + productCreateMedia
  });

  it("processes rows out of a fully-sequential loop (bounded concurrency) while preserving row order", async () => {
    // 12 products > CONCURRENCY(5) — exercises multiple concurrent batches.
    const products = Array.from({ length: 12 }, (_, i) => ({ title: `Product ${i + 1}` }));
    for (let i = 0; i < products.length; i++) {
      fetchMock.mockResolvedValueOnce(productCreateResponse(String(1000 + i)));
    }
    const req = mockActionRequest({ products: JSON.stringify(products), fileName: "p.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(12);
    expect(result.errorCount).toBe(0);
    // Results must stay in original row order despite concurrent processing.
    expect(result.results.map((r) => r.row)).toEqual([...Array(12)].map((_, i) => i + 1));
    expect(result.results.map((r) => r.title)).toEqual(products.map((p) => p.title));
  });

  it("retries once on a 429 before creating the product", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(productCreateResponse("333"));
    const req = mockActionRequest({ products: JSON.stringify([{ title: "Retried Product" }]), fileName: "p.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0].productId).toBe("333");
  });

  it("records an ImportJob with aggregate counts", async () => {
    fetchMock.mockResolvedValueOnce(productCreateResponse("444"));
    const req = mockActionRequest({ products: JSON.stringify([{ title: "Logged Product" }]), fileName: "widgets.csv" });
    await action({ request: req });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fileName: "widgets.csv",
        totalRows: 1,
        successCount: 1,
        errorCount: 0,
        status: "completed",
      }),
    }));
  });

  it("returns a failed status for invalid JSON product payloads", async () => {
    const req = { formData: async () => { const fd = new FormData(); fd.append("products", "not-json"); return fd; } };
    const result = await action({ request: req });
    expect(result.status).toBe("failed");
    expect(result.errorCount).toBe(1);
  });

  it("idempotency: skips creating a product when one with the same handle already exists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { products: { edges: [{ node: { id: "gid://shopify/Product/777" } }] } } }));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "Duplicate Tee", handle: "duplicate-tee" }]),
      fileName: "p.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "success", productId: "777", skipped: true });
    // location fetch + the handle-existence check — no productCreate call
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Regression coverage for a production bug: productCreate used to receive
  // "options"/"variants" directly on ProductInput, which the pinned API
  // version rejects ("Field is not defined on ProductInput"). Asserts the
  // actual payloads sent for a multi-variant CSV row use the corrected
  // two-mutation shape (productCreate + productVariantsBulkCreate).
  it("creates a multi-variant product via productCreate(productOptions) + productVariantsBulkCreate, never a bare options/variants field", async () => {
    let productCreateVariables = null;
    let bulkCreateVariables = null;
    fetchMock.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes("locations(first: 1)")) return jsonResponse({ data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } });
      if (body.query.includes("mutation ProductVariantsBulkCreate")) {
        bulkCreateVariables = body.variables;
        return variantsBulkCreateResponse(2);
      }
      if (body.query.includes("mutation ProductCreate")) {
        productCreateVariables = body.variables;
        return productCreateResponse("999");
      }
      throw new Error(`Unexpected fetch: ${body.query.slice(0, 100)}`);
    });

    const req = mockActionRequest({
      products: JSON.stringify([{
        title: "Variant Shirt",
        option1_name: "Size",
        variants: [
          { option1: "Small", price: "15.00", sku: "SHIRT-S" },
          { option1: "Medium", price: "15.00", sku: "SHIRT-M" },
        ],
      }]),
      fileName: "p.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(productCreateVariables.product).not.toHaveProperty("options");
    expect(productCreateVariables.product).not.toHaveProperty("variants");
    expect(productCreateVariables.product.productOptions).toEqual([
      { name: "Size", values: [{ name: "Small" }, { name: "Medium" }] },
    ]);
    expect(bulkCreateVariables.strategy).toBe("REMOVE_STANDALONE_VARIANT");
    expect(bulkCreateVariables.variants).toHaveLength(2);
    expect(bulkCreateVariables.variants[0]).toMatchObject({
      price: "15.00",
      optionValues: [{ optionName: "Size", name: "Small" }],
      inventoryItem: { sku: "SHIRT-S" },
    });
  });

  it("creates the product when the handle doesn't already exist", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { products: { edges: [] } } })) // no existing product
      .mockResolvedValueOnce(productCreateResponse("888"));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "New Tee", handle: "new-tee" }]),
      fileName: "p.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "success", productId: "888" });
    expect(result.results[0].skipped).toBeUndefined();
  });
});
