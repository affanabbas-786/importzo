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

import { action } from "../../app/routes/app.woocommerce-importer.jsx";

function productCreateResponse(id, errors = []) {
  return jsonResponse({ data: { productCreate: { product: errors.length ? null : { id: `gid://shopify/Product/${id}` }, userErrors: errors } } });
}

function variantsBulkCreateResponse(count, errors = []) {
  return jsonResponse({ data: { productVariantsBulkCreate: { productVariants: errors.length ? [] : Array.from({ length: count }, (_, i) => ({ id: `gid://shopify/ProductVariant/${i}` })), userErrors: errors } } });
}

describe("app.woocommerce-importer action", () => {
  let fetchMock;

  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a simple WooCommerce product and reports success", async () => {
    // Every WooCommerce-built product carries a variants array (even a
    // "simple" product is one variant), so productVariantsBulkCreate is
    // always the second call after productCreate — see
    // product-variants.server.js: it fires whenever variants.length > 0,
    // not only when options are present.
    fetchMock
      .mockResolvedValueOnce(productCreateResponse("111"))
      .mockResolvedValueOnce(variantsBulkCreateResponse(1));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "Cotton T-Shirt", variants: [{ price: "19.99", sku: "TS-100" }] }]),
      fileName: "woo-export.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.results[0]).toMatchObject({ row: 1, title: "Cotton T-Shirt", status: "success", productId: "111" });
  });

  it("creates a variable product's variants via productVariantsBulkCreate", async () => {
    fetchMock
      .mockResolvedValueOnce(productCreateResponse("222"))
      .mockResolvedValueOnce(variantsBulkCreateResponse(2));
    const req = mockActionRequest({
      products: JSON.stringify([{
        title: "Zip Hoodie", option1_name: "Size",
        variants: [
          { option1: "Small", price: "39.99", sku: "HOODIE-S" },
          { option1: "Medium", price: "34.99", compareAtPrice: "39.99", sku: "HOODIE-M" },
        ],
      }]),
      fileName: "woo-export.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0].variantCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3); // location + productCreate + variantsBulkCreate
  });

  it("reports a failed row without aborting the whole import", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { productCreate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } } }),
    );
    const req = mockActionRequest({ products: JSON.stringify([{ title: "" }]), fileName: "woo.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.results[0].error).toMatch(/Title can't be blank/);
  });

  it("attaches images via productCreateMedia after product creation", async () => {
    fetchMock
      .mockResolvedValueOnce(productCreateResponse("333"))
      .mockResolvedValueOnce(variantsBulkCreateResponse(1))
      .mockResolvedValueOnce(jsonResponse({ data: { productCreateMedia: { media: [{ id: "gid://shopify/MediaImage/1" }], mediaUserErrors: [] } } }));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "Mug", images: ["https://example.com/a.jpg"], variants: [{ price: "9.99" }] }]),
      fileName: "woo.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4); // location + productCreate + variantsBulkCreate + productCreateMedia
  });

  it("idempotency: skips creating a product when one with the same handle already exists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { products: { edges: [{ node: { id: "gid://shopify/Product/777" } }] } } }));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "Duplicate Tee", handle: "ts-100", variants: [{ price: "19.99" }] }]),
      fileName: "woo.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "success", productId: "777", skipped: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // location + handle-existence check, no productCreate
  });

  it("records an ImportJob tagged with importType=woocommerce", async () => {
    fetchMock
      .mockResolvedValueOnce(productCreateResponse("444"))
      .mockResolvedValueOnce(variantsBulkCreateResponse(1));
    const req = mockActionRequest({
      products: JSON.stringify([{ title: "Logged Product", variants: [{ price: "5.00" }] }]),
      fileName: "widgets.csv",
    });
    await action({ request: req });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fileName: "widgets.csv", totalRows: 1, successCount: 1, errorCount: 0,
        status: "completed", importType: "woocommerce",
      }),
    }));
  });

  it("returns a failed status for invalid JSON product payloads", async () => {
    const req = { formData: async () => { const fd = new FormData(); fd.append("products", "not-json"); return fd; } };
    const result = await action({ request: req });
    expect(result.status).toBe("failed");
    expect(result.errorCount).toBe(1);
  });

  it("processes rows out of a fully-sequential loop (bounded concurrency) while preserving row order", async () => {
    // Each product makes TWO sequential fetch calls (productCreate, then
    // productVariantsBulkCreate), so with 5 concurrent products in flight a
    // plain FIFO mockResolvedValueOnce queue doesn't line up with which
    // product actually issued which call — a content-aware mock keyed off
    // the mutation name in the request body sidesteps that entirely.
    let productSeq = 0;
    fetchMock.mockImplementation(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const query = body.query || "";
      if (query.includes("productVariantsBulkCreate")) return variantsBulkCreateResponse(1);
      if (query.includes("productCreate")) return productCreateResponse(String(2000 + productSeq++));
      return jsonResponse({ data: {} });
    });

    const products = Array.from({ length: 12 }, (_, i) => ({ title: `Product ${i + 1}`, variants: [{ price: "1.00" }] }));
    const req = mockActionRequest({ products: JSON.stringify(products), fileName: "woo.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(12);
    expect(result.results.map((r) => r.row)).toEqual([...Array(12)].map((_, i) => i + 1));
    expect(result.results.map((r) => r.title)).toEqual(products.map((p) => p.title));
  });
});
