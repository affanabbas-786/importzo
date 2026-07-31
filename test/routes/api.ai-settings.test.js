import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildFormData } from "../../app/lib/test-helpers.js";

const db = { integrations: [] };
const SHOP = "dest-shop.myshopify.com";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
}));

vi.mock("../../app/db.server", () => ({
  default: {
    aiIntegration: {
      findUnique: vi.fn(async ({ where: { shop } }) => db.integrations.find((i) => i.shop === shop) || null),
      upsert: vi.fn(async ({ where: { shop }, create, update }) => {
        const existing = db.integrations.find((i) => i.shop === shop);
        if (existing) { Object.assign(existing, update, { updatedAt: new Date() }); return existing; }
        const row = { id: `ai-${db.integrations.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        db.integrations.push(row);
        return row;
      }),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = db.integrations.find((i) => i.shop === shop);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      deleteMany: vi.fn(async ({ where: { shop } }) => {
        const before = db.integrations.length;
        db.integrations = db.integrations.filter((i) => i.shop !== shop);
        return { count: before - db.integrations.length };
      }),
    },
  },
}));

import { loader, action } from "../../app/routes/api.ai-settings.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";

describe("api.ai-settings", () => {
  let originalEncryptionKey;

  beforeEach(() => {
    db.integrations = [];
    __resetRateLimitState();
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    vi.restoreAllMocks();
  });

  describe("loader", () => {
    it("returns null integration when none is configured", async () => {
      const response = await loader({ request: { url: "https://app.test/api/ai-settings" } });
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.integration).toBeNull();
      expect(body.providers).toEqual(["anthropic", "openai"]);
    });

    it("never includes the API key in the response", async () => {
      const req1 = { method: "POST", formData: async () => buildFormData({ intent: "save", provider: "anthropic", apiKey: "sk-ant-super-secret", model: "" }) };
      await action({ request: req1 });

      const response = await loader({ request: { url: "https://app.test/api/ai-settings" } });
      const body = await response.json();
      expect(body.integration.provider).toBe("anthropic");
      expect(JSON.stringify(body)).not.toContain("sk-ant-super-secret");
    });
  });

  describe("action (save)", () => {
    it("saves a new integration", async () => {
      const req = { method: "POST", formData: async () => buildFormData({ intent: "save", provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" }) };
      const response = await action({ request: req });
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.integration).toMatchObject({ provider: "openai", model: "gpt-4o-mini", enabled: true });
    });

    it("400s on an unknown provider", async () => {
      const req = { method: "POST", formData: async () => buildFormData({ intent: "save", provider: "bogus", apiKey: "key" }) };
      const response = await action({ request: req });
      expect(response.status).toBe(400);
    });
  });

  describe("action (enable/disable)", () => {
    it("disables and re-enables an integration", async () => {
      await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "save", provider: "anthropic", apiKey: "sk-1" }) } });

      const disableRes = await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "disable" }) } });
      expect((await disableRes.json()).integration.enabled).toBe(false);

      const enableRes = await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "enable" }) } });
      expect((await enableRes.json()).integration.enabled).toBe(true);
    });

    it("404s disabling when nothing is configured", async () => {
      const response = await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "disable" }) } });
      expect(response.status).toBe(404);
    });
  });

  describe("action (delete)", () => {
    it("removes the integration", async () => {
      await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "save", provider: "anthropic", apiKey: "sk-1" }) } });
      const response = await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "delete" }) } });
      expect((await response.json()).ok).toBe(true);
      expect(db.integrations).toHaveLength(0);
    });
  });

  it("rejects non-POST methods on the action", async () => {
    const response = await action({ request: { method: "GET" } });
    expect(response.status).toBe(405);
  });

  it("rejects an unknown intent", async () => {
    const response = await action({ request: { method: "POST", formData: async () => buildFormData({ intent: "bogus" }) } });
    expect(response.status).toBe(400);
  });
});
