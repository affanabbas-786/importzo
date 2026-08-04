import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, buildFormData } from "../../app/lib/test-helpers.js";

const db = { integrations: [], plans: new Map() };
const SHOP = "dest-shop.myshopify.com";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

function setShopPlan(shop, data) {
  db.plans.set(shop, {
    id: "plan-preset", shop, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    aiCallsUsed: 0, aiUsagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...data,
  });
}

vi.mock("../../app/db.server", () => ({
  default: {
    aiIntegration: {
      findUnique: vi.fn(async ({ where: { shop } }) => db.integrations.find((i) => i.shop === shop) || null),
    },
    // Phase 6: built-in-AI (groq_builtin) calls are tier/quota-gated the
    // same way scheduled sync and record quota are — see usage.server.js.
    shopPlan: {
      upsert: vi.fn(async ({ where: { shop }, update, create }) => {
        const existing = db.plans.get(shop);
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const row = {
          id: "plan-1", recordsUsed: 0, aiCallsUsed: 0, subscriptionId: null, subscriptionStatus: null,
          shopOwnerEmail: null, uninstalledAt: null, createdAt: new Date(), updatedAt: new Date(), ...create,
        };
        db.plans.set(shop, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = db.plans.get(shop);
        if (!row) throw new Error("Record to update not found.");
        const patch = { ...data };
        if (patch.aiCallsUsed && typeof patch.aiCallsUsed === "object" && "increment" in patch.aiCallsUsed) {
          patch.aiCallsUsed = (row.aiCallsUsed || 0) + patch.aiCallsUsed.increment;
        }
        Object.assign(row, patch);
        return { ...row };
      }),
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
    db.plans = new Map();
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

  describe("intent=suggest — groq_builtin (Phase 6)", () => {
    it("refuses a Free-tier shop before ever calling the provider", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "free" });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });

      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/requires the Pro or Agency plan/i);
      expect(generateSeoCopyMock).not.toHaveBeenCalled();
    });

    it("refuses once the shared 500-call monthly budget is exhausted", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "pro", aiCallsUsed: 500 });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });

      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/used all 500 built-in AI suggestions/i);
      expect(generateSeoCopyMock).not.toHaveBeenCalled();
    });

    it("allows an eligible shop with budget remaining, and records one call on success", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "agency", aiCallsUsed: 10 });
      global.fetch.mockResolvedValueOnce(jsonResponse({
        data: { product: { id: "gid://shopify/Product/123", title: "T", descriptionHtml: "D" } },
      }));
      generateSeoCopyMock.mockResolvedValue({ ok: true, title: "New Title", description: "New description" });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      const response = await action({ request: req });

      expect(response.status).toBe(200);
      const call = generateSeoCopyMock.mock.calls[0][0];
      expect(call.provider).toBe("groq_builtin");
      expect(db.plans.get(SHOP).aiCallsUsed).toBe(11);
    });

    it("does not spend a call when the provider call fails", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "pro", aiCallsUsed: 10 });
      global.fetch.mockResolvedValueOnce(jsonResponse({
        data: { product: { id: "gid://shopify/Product/123", title: "T", descriptionHtml: "D" } },
      }));
      generateSeoCopyMock.mockResolvedValue({ ok: false, error: "provider outage" });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      await action({ request: req });

      expect(db.plans.get(SHOP).aiCallsUsed).toBe(10); // unchanged
    });

    it("never touches ShopPlan for a plain BYOK (anthropic/openai) suggestion", async () => {
      seedIntegration(); // anthropic, from the default seedIntegration()
      global.fetch.mockResolvedValueOnce(jsonResponse({
        data: { product: { id: "gid://shopify/Product/123", title: "T", descriptionHtml: "D" } },
      }));
      generateSeoCopyMock.mockResolvedValue({ ok: true, title: "New Title", description: "New description" });

      const req = { method: "POST", formData: async () => buildFormData({ intent: "suggest", productId: "123" }) };
      await action({ request: req });

      expect(db.plans.size).toBe(0); // no ShopPlan row ever created/read for a BYOK call
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
