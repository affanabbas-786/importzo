import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, buildFormData } from "../../app/lib/test-helpers.js";

const db = { integrations: [] };
const SHOP = "dest-shop.myshopify.com";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    aiIntegration: {
      findUnique: vi.fn(async ({ where: { shop } }) => db.integrations.find((i) => i.shop === shop) || null),
    },
  },
}));

const generateSeoCopyMock = vi.fn();
vi.mock("../../app/lib/ai-provider.server", () => ({
  generateSeoCopy: (...args) => generateSeoCopyMock(...args),
}));

import { action } from "../../app/routes/api.ai-enhance.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";
import { encrypt } from "../../app/utils/encryption.server.js";

describe("api.ai-enhance", () => {
  let originalEncryptionKey;

  beforeEach(() => {
    db.integrations = [];
    generateSeoCopyMock.mockReset();
    __resetRateLimitState();
    global.fetch = vi.fn();
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    vi.restoreAllMocks();
  });

  function seedIntegration(overrides = {}) {
    db.integrations.push({
      id: "ai-1", shop: SHOP, provider: "anthropic",
      apiKey: encrypt("sk-ant-secret"), model: "claude-haiku-4-5", enabled: true,
      ...overrides,
    });
  }

  describe("intent=suggest", () => {
    it("400s with a clear message when no AI integration is configured", async () => {
      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/Settings/);
      expect(generateSeoCopyMock).not.toHaveBeenCalled();
    });

    it("fetches the product, calls the configured provider, and returns the suggestion without applying it", async () => {
      seedIntegration();
      global.fetch.mockResolvedValueOnce(jsonResponse({
        data: { product: { id: "gid://shopify/Product/123", title: "Old Title", descriptionHtml: "<p>Old desc</p>", vendor: "Acme", productType: "Widgets", tags: ["a"] } },
      }));
      generateSeoCopyMock.mockResolvedValue({ ok: true, title: "New Title", description: "New description" });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.current).toEqual({ title: "Old Title", description: "<p>Old desc</p>" });
      expect(body.suggested).toEqual({ title: "New Title", description: "New description" });

      // The merchant's decrypted key reached the provider call, not the ciphertext.
      const call = generateSeoCopyMock.mock.calls[0][0];
      expect(call.apiKey).toBe("sk-ant-secret");
      expect(call.provider).toBe("anthropic");

      // Nothing was written — only a read (GraphQL product query), no productUpdate.
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("404s when the product doesn't exist", async () => {
      seedIntegration();
      global.fetch.mockResolvedValueOnce(jsonResponse({ data: { product: null } }));
      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "999" }) };
      const response = await action({ request: req });
      expect(response.status).toBe(404);
    });

    it("returns 502 when the provider call fails", async () => {
      seedIntegration();
      global.fetch.mockResolvedValueOnce(jsonResponse({ data: { product: { id: "gid://shopify/Product/123", title: "T", descriptionHtml: "D" } } }));
      generateSeoCopyMock.mockResolvedValue({ ok: false, error: "Rate limited by provider" });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });
      const body = await response.json();
      expect(response.status).toBe(502);
      expect(body.error).toMatch(/Rate limited/);
    });

    it("does not call the provider when the integration is disabled", async () => {
      seedIntegration({ enabled: false });
      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });
      expect(response.status).toBe(400);
      expect(generateSeoCopyMock).not.toHaveBeenCalled();
    });
  });

  describe("intent=apply", () => {
    it("writes only title and descriptionHtml via productUpdate", async () => {
      global.fetch.mockResolvedValueOnce(jsonResponse({
        data: { productUpdate: { product: { id: "gid://shopify/Product/123", title: "New Title", descriptionHtml: "New description" }, userErrors: [] } },
      }));

      const req = { method: "POST", formData: async () => buildFormData({ intent: "apply", productId: "123", title: "New Title", description: "New description" }) };
      const response = await action({ request: req });
      const body = await response.json();

      expect(body.ok).toBe(true);
      const [, opts] = global.fetch.mock.calls[0];
      const sent = JSON.parse(opts.body);
      expect(sent.variables.input).toEqual({ id: "gid://shopify/Product/123", title: "New Title", descriptionHtml: "New description" });
    });

    it("400s when title is missing", async () => {
      const req = { method: "POST", formData: async () => buildFormData({ intent: "apply", productId: "123", title: "", description: "d" }) };
      const response = await action({ request: req });
      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("surfaces productUpdate userErrors instead of reporting success", async () => {
      global.fetch.mockResolvedValueOnce(jsonResponse({
        data: { productUpdate: { product: null, userErrors: [{ field: ["title"], message: "Title can't be blank" }] } },
      }));
      const req = { method: "POST", formData: async () => buildFormData({ intent: "apply", productId: "123", title: "X", description: "d" }) };
      const response = await action({ request: req });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/Title can't be blank/);
    });
  });

  it("rejects non-POST methods", async () => {
    const response = await action({ request: { method: "GET" } });
    expect(response.status).toBe(405);
  });

  it("400s when productId is missing", async () => {
    const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest" }) };
    const response = await action({ request: req });
    expect(response.status).toBe(400);
  });
});
