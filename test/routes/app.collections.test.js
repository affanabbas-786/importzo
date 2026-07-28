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

import { action } from "../../app/routes/app.collections.jsx";

function collectionCreateResponse(id, errors = []) {
  return jsonResponse({ data: { collectionCreate: { collection: errors.length ? null : { id: `gid://shopify/Collection/${id}` }, userErrors: errors } } });
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
    fetchMock.mockResolvedValueOnce(collectionCreateResponse("1"));
    const req = mockActionRequest({ collections: JSON.stringify([{ title: "Summer" }]), fileName: "c.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "success", type: "custom", collectionId: "1" });
  });

  it("creates a smart collection with parsed rules", async () => {
    fetchMock.mockResolvedValueOnce(collectionCreateResponse("2"));
    const req = mockActionRequest({
      collections: JSON.stringify([{ title: "Sale Items", collection_type: "smart", rules_column: "tag:equals:sale" }]),
      fileName: "c.csv",
    });
    const result = await action({ request: req });

    expect(result.successCount).toBe(1);
    expect(result.results[0].type).toBe("smart");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.input.ruleSet.rules[0]).toMatchObject({ column: "TAG", relation: "EQUALS", condition: "sale" });
  });

  it("retries collection creation without the image if the image URL fails, marking it a warning-success", async () => {
    fetchMock
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
    const collections = Array.from({ length: 9 }, (_, i) => ({ title: `Collection ${i + 1}` }));
    for (let i = 0; i < collections.length; i++) fetchMock.mockResolvedValueOnce(collectionCreateResponse(String(i)));
    const req = mockActionRequest({ collections: JSON.stringify(collections), fileName: "c.csv" });
    const result = await action({ request: req });

    expect(result.successCount).toBe(9);
    expect(result.results.map((r) => r.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("retries on a 429 before creating the collection", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(collectionCreateResponse("5"));
    const req = mockActionRequest({ collections: JSON.stringify([{ title: "Retried" }]), fileName: "c.csv" });
    const result = await action({ request: req });
    expect(result.successCount).toBe(1);
  });
});
