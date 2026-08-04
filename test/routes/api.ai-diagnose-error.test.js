import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildFormData } from "../../app/lib/test-helpers.js";

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

const explainErrorMock = vi.fn();
vi.mock("../../app/lib/ai-provider.server", () => ({
  explainError: (...args) => explainErrorMock(...args),
}));

import { action } from "../../app/routes/api.ai-diagnose-error.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";
import { encrypt } from "../../app/utils/encryption.server.js";

describe("api.ai-diagnose-error", () => {
  let originalEncryptionKey;

  beforeEach(() => {
    db.integrations = [];
    db.plans = new Map();
    explainErrorMock.mockReset();
    __resetRateLimitState();
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

  it("rejects non-POST methods", async () => {
    const response = await action({ request: { method: "GET" } });
    expect(response.status).toBe(405);
  });

  it("400s when error is missing", async () => {
    const req = { method: "POST", formData: async () => buildFormData({ itemLabel: "Blue Shirt" }) };
    const response = await action({ request: req });
    expect(response.status).toBe(400);
    expect(explainErrorMock).not.toHaveBeenCalled();
  });

  it("400s with a clear message when no AI integration is configured", async () => {
    const req = { method: "POST", formData: async () => buildFormData({ error: "Variant SKU has already been taken" }) };
    const response = await action({ request: req });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Settings/);
    expect(explainErrorMock).not.toHaveBeenCalled();
  });

  it("explains the error using the configured BYOK provider", async () => {
    seedIntegration();
    explainErrorMock.mockResolvedValue({ ok: true, explanation: "This SKU already exists — use a unique one or enable overwrite mode." });

    const req = { method: "POST", formData: async () => buildFormData({ error: "Variant SKU has already been taken", itemLabel: "Blue T-Shirt" }) };
    const response = await action({ request: req });
    const body = await response.json();

    expect(body).toEqual({ ok: true, explanation: "This SKU already exists — use a unique one or enable overwrite mode." });
    const call = explainErrorMock.mock.calls[0][0];
    expect(call.apiKey).toBe("sk-ant-secret");
    expect(call.errorMessage).toBe("Variant SKU has already been taken");
    expect(call.itemLabel).toBe("Blue T-Shirt");
  });

  it("returns 502 when the provider call fails", async () => {
    seedIntegration();
    explainErrorMock.mockResolvedValue({ ok: false, error: "Provider outage" });
    const req = { method: "POST", formData: async () => buildFormData({ error: "some error" }) };
    const response = await action({ request: req });
    expect(response.status).toBe(502);
  });

  it("does not call the provider when the integration is disabled", async () => {
    seedIntegration({ enabled: false });
    const req = { method: "POST", formData: async () => buildFormData({ error: "some error" }) };
    const response = await action({ request: req });
    expect(response.status).toBe(400);
    expect(explainErrorMock).not.toHaveBeenCalled();
  });

  describe("groq_builtin gating", () => {
    it("refuses a Free-tier shop before calling the provider", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "free" });

      const req = { method: "POST", formData: async () => buildFormData({ error: "some error" }) };
      const response = await action({ request: req });

      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/requires the Pro or Agency plan/i);
      expect(explainErrorMock).not.toHaveBeenCalled();
    });

    it("refuses once the shared monthly budget is exhausted", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "pro", aiCallsUsed: 500 });

      const req = { method: "POST", formData: async () => buildFormData({ error: "some error" }) };
      const response = await action({ request: req });

      expect(response.status).toBe(403);
      expect(explainErrorMock).not.toHaveBeenCalled();
    });

    it("allows an eligible shop and records one shared call on success", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "agency", aiCallsUsed: 3 });
      explainErrorMock.mockResolvedValue({ ok: true, explanation: "Explanation." });

      const req = { method: "POST", formData: async () => buildFormData({ error: "some error" }) };
      const response = await action({ request: req });

      expect(response.status).toBe(200);
      expect(db.plans.get(SHOP).aiCallsUsed).toBe(4);
    });

    it("does not spend a call when the provider fails", async () => {
      seedIntegration({ provider: "groq_builtin", apiKey: encrypt("built-in"), model: "llama-3.1-8b-instant" });
      setShopPlan(SHOP, { tier: "pro", aiCallsUsed: 3 });
      explainErrorMock.mockResolvedValue({ ok: false, error: "outage" });

      const req = { method: "POST", formData: async () => buildFormData({ error: "some error" }) };
      await action({ request: req });

      expect(db.plans.get(SHOP).aiCallsUsed).toBe(3);
    });
  });
});
