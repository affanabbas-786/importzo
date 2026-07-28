import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

import { action } from "../../app/routes/app.export.jsx";

function pageResponse(field, nodes, hasNextPage = false) {
  return jsonResponse({ data: { [field]: { edges: nodes.map((n) => ({ cursor: n.__cursor || "c", node: n })), pageInfo: { hasNextPage } } } });
}

// The action always returns Response.json(...) — a real Response, not a
// plain object — so every call site needs to unwrap it via .json().
async function callAction(fields) {
  const response = await action({ request: mockActionRequest(fields) });
  return response.json();
}

describe("app.export action", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns store counts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { productsCount: { count: 12 }, collectionsCount: { count: 3 }, customersCount: { count: 40 } } }));
    const result = await callAction({ intent: "counts" });

    expect(result).toMatchObject({ ok: true, products: 12, collections: 3, customers: 40 });
  });

  it("exports products as CSV, one row per variant", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse("products", [
      {
        handle: "tee", title: "Tee", descriptionHtml: "<p>desc</p>", vendor: "Acme", productType: "Apparel", tags: ["a", "b"], status: "ACTIVE",
        options: [{ name: "Size" }],
        images: { edges: [{ node: { url: "https://example.com/tee.jpg" } }] },
        variants: {
          edges: [
            { node: { sku: "TEE-S", price: "10.00", compareAtPrice: null, barcode: "", inventoryQuantity: 5, inventoryItem: { measurement: { weight: { value: 1, unit: "KILOGRAMS" } } }, selectedOptions: [{ name: "Size", value: "S" }] } },
            { node: { sku: "TEE-M", price: "10.00", compareAtPrice: null, barcode: "", inventoryQuantity: 3, inventoryItem: { measurement: { weight: { value: 1, unit: "KILOGRAMS" } } }, selectedOptions: [{ name: "Size", value: "M" }] } },
          ],
        },
      },
    ]));
    const result = await callAction({ intent: "export-products" });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    const lines = result.csv.split("\n");
    expect(lines[0]).toContain("Handle");
    expect(lines).toHaveLength(3); // header + 2 variant rows
    expect(lines[1]).toContain("tee");
    expect(lines[1]).toContain("TEE-S");
    expect(lines[2]).toContain("TEE-M");
  });

  it("paginates through multiple product pages", async () => {
    fetchMock
      .mockResolvedValueOnce(pageResponse("products", [{ handle: "p1", title: "P1", options: [], images: { edges: [] }, variants: { edges: [] } }], true))
      .mockResolvedValueOnce(pageResponse("products", [{ handle: "p2", title: "P2", options: [], images: { edges: [] }, variants: { edges: [] } }], false));
    const result = await callAction({ intent: "export-products" });

    expect(result.count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exports collections with type derived from ruleSet presence", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse("collections", [
      { handle: "sale", title: "Sale", descriptionHtml: "", sortOrder: "MANUAL", ruleSet: { rules: [] }, image: null },
      { handle: "new", title: "New Arrivals", descriptionHtml: "", sortOrder: "MANUAL", ruleSet: null, image: null },
    ]));
    const result = await callAction({ intent: "export-collections" });

    expect(result.count).toBe(2);
    expect(result.csv).toContain("Smart");
    expect(result.csv).toContain("Custom");
  });

  it("exports inventory rows only for variants with a SKU", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse("products", [
      { title: "Tee", variants: { edges: [{ node: { sku: "TEE-1", price: "10", barcode: "", inventoryQuantity: 5, title: "Default" } }, { node: { sku: "", price: "10", barcode: "", inventoryQuantity: 0, title: "No SKU" } }] } },
    ]));
    const result = await callAction({ intent: "export-inventory" });

    expect(result.count).toBe(1);
    expect(result.csv).toContain("TEE-1");
    expect(result.csv).not.toContain("No SKU");
  });

  it("exports customers", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse("customers", [
      { firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: "", emailMarketingConsent: { marketingState: "SUBSCRIBED" }, numberOfOrders: 2, amountSpent: { amount: "50.00" }, tags: ["vip"], note: "", state: "ENABLED" },
    ]));
    const result = await callAction({ intent: "export-customers" });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.csv).toContain("jane@example.com");
  });

  it("returns a 403 with a clear message when customer export lacks permission", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: "This action requires merchant approval for protected customer data" }] }));
    const req = mockActionRequest({ intent: "export-customers" });
    const response = await action({ request: req });

    // Response.json in this route returns a Response object when status !== 200
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/read_customers|protected customer/i);
  });

  it("retries a 429 during export before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(pageResponse("products", [{ handle: "p1", title: "P1", options: [], images: { edges: [] }, variants: { edges: [] } }]));
    const result = await callAction({ intent: "export-products" });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });

  it("returns a 400 for an unknown intent", async () => {
    const req = mockActionRequest({ intent: "export-bogus" });
    const response = await action({ request: req });
    expect(response.status).toBe(400);
  });

  it("surfaces a 500 error response if the GraphQL call fails unexpectedly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
    const req = mockActionRequest({ intent: "export-products" });
    const response = await action({ request: req });
    expect(response.status).toBe(500);
  });
});
