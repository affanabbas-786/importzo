import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAiIntegrationPublic, getAiIntegrationForUse, saveAiIntegration,
  setAiIntegrationEnabled, deleteAiIntegration, PROVIDERS, SUGGESTED_MODELS,
  BUILT_IN_PROVIDER, BUILT_IN_MODEL, ALL_PROVIDERS,
} from "./ai-settings.server.js";

function fakePrisma() {
  const rows = new Map();
  return {
    aiIntegration: {
      findUnique: vi.fn(async ({ where: { shop } }) => rows.get(shop) || null),
      upsert: vi.fn(async ({ where: { shop }, create, update }) => {
        const existing = rows.get(shop);
        const row = existing
          ? Object.assign(existing, update, { updatedAt: new Date() })
          : { id: `ai-${rows.size + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        rows.set(shop, row);
        return row;
      }),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = rows.get(shop);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      deleteMany: vi.fn(async ({ where: { shop } }) => {
        const existed = rows.has(shop);
        rows.delete(shop);
        return { count: existed ? 1 : 0 };
      }),
    },
    __rows: rows,
  };
}

const SHOP = "dest-shop.myshopify.com";

describe("saveAiIntegration", () => {
  let originalEncryptionKey;
  beforeEach(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
  });
  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("saves a new integration with the key encrypted at rest", async () => {
    const prisma = fakePrisma();
    const result = await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-secret", model: "claude-haiku-4-5" });

    expect(result.ok).toBe(true);
    expect(result.integration).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", enabled: true, updatedAt: expect.any(Date) });
    const stored = prisma.__rows.get(SHOP);
    expect(stored.apiKey).not.toBe("sk-ant-secret"); // encrypted
    expect(stored.apiKey).not.toContain("sk-ant-secret");
  });

  it("rejects an unknown provider", async () => {
    const prisma = fakePrisma();
    const result = await saveAiIntegration({ prisma, shop: SHOP, provider: "bogus", apiKey: "key" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown provider/);
  });

  it("rejects an empty API key", async () => {
    const prisma = fakePrisma();
    const result = await saveAiIntegration({ prisma, shop: SHOP, provider: "openai", apiKey: "   " });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it("falls back to null model when none is given (resolved to a suggested default on read)", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "openai", apiKey: "sk-test" });
    const stored = prisma.__rows.get(SHOP);
    expect(stored.model).toBeNull();
  });

  it("re-saving replaces the provider, key, and model (one integration per shop)", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-1", model: "claude-haiku-4-5" });
    await saveAiIntegration({ prisma, shop: SHOP, provider: "openai", apiKey: "sk-openai-1", model: "gpt-4o-mini" });

    expect(prisma.__rows.size).toBe(1);
    const forUse = await getAiIntegrationForUse({ prisma, shop: SHOP });
    expect(forUse.provider).toBe("openai");
    expect(forUse.apiKey).toBe("sk-openai-1");
  });

  it("re-enables a previously disabled integration on save", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-1" });
    await setAiIntegrationEnabled({ prisma, shop: SHOP, enabled: false });
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-2" });

    const pub = await getAiIntegrationPublic({ prisma, shop: SHOP });
    expect(pub.enabled).toBe(true);
  });
});

describe("getAiIntegrationPublic / getAiIntegrationForUse", () => {
  let originalEncryptionKey;
  beforeEach(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
  });
  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("never returns the API key in the public view", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-secret" });
    const pub = await getAiIntegrationPublic({ prisma, shop: SHOP });
    expect(pub).not.toHaveProperty("apiKey");
    expect(JSON.stringify(pub)).not.toContain("sk-ant-secret");
  });

  it("returns null when no integration is configured", async () => {
    const prisma = fakePrisma();
    expect(await getAiIntegrationPublic({ prisma, shop: SHOP })).toBeNull();
    expect(await getAiIntegrationForUse({ prisma, shop: SHOP })).toBeNull();
  });

  it("decrypts the key for internal use", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "openai", apiKey: "sk-plain-text" });
    const forUse = await getAiIntegrationForUse({ prisma, shop: SHOP });
    expect(forUse.apiKey).toBe("sk-plain-text");
  });

  it("resolves a missing model to the provider's suggested default, both for use and in the public view", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-1" });
    const forUse = await getAiIntegrationForUse({ prisma, shop: SHOP });
    expect(forUse.model).toBe(SUGGESTED_MODELS.anthropic);
    const pub = await getAiIntegrationPublic({ prisma, shop: SHOP });
    expect(pub.model).toBe(SUGGESTED_MODELS.anthropic); // shown so the settings UI reflects the effective model
  });

  it("does not use a disabled integration for calls, but still shows it in the public view", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-1" });
    await setAiIntegrationEnabled({ prisma, shop: SHOP, enabled: false });

    expect(await getAiIntegrationForUse({ prisma, shop: SHOP })).toBeNull();
    const pub = await getAiIntegrationPublic({ prisma, shop: SHOP });
    expect(pub.enabled).toBe(false);
  });
});

describe("deleteAiIntegration", () => {
  it("removes the shop's integration", async () => {
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-1" });
    await deleteAiIntegration({ prisma, shop: SHOP });
    expect(await getAiIntegrationPublic({ prisma, shop: SHOP })).toBeNull();
  });

  it("is a no-op (not an error) when nothing is configured", async () => {
    const prisma = fakePrisma();
    const result = await deleteAiIntegration({ prisma, shop: SHOP });
    expect(result.ok).toBe(true);
  });
});

describe("PROVIDERS / SUGGESTED_MODELS", () => {
  it("has a suggested default model for every declared provider", () => {
    for (const p of PROVIDERS) {
      expect(SUGGESTED_MODELS[p]).toBeTruthy();
    }
  });

  it("ALL_PROVIDERS includes the built-in provider alongside BYOK", () => {
    expect(ALL_PROVIDERS).toContain(BUILT_IN_PROVIDER);
    expect(ALL_PROVIDERS).toEqual([...PROVIDERS, BUILT_IN_PROVIDER]);
  });
});

describe("groq_builtin (Phase 6 — built-in AI)", () => {
  let originalEncryptionKey, originalGroqKey;
  beforeEach(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key-long-enough-to-pass-validation-0123456789";
    originalGroqKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "gsk_shared_test_key";
  });
  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;
  });

  it("saves a built-in selection without requiring an apiKey argument", async () => {
    const prisma = fakePrisma();
    const result = await saveAiIntegration({ prisma, shop: SHOP, provider: BUILT_IN_PROVIDER });
    expect(result.ok).toBe(true);
    expect(result.integration).toEqual({ provider: BUILT_IN_PROVIDER, model: BUILT_IN_MODEL, enabled: true, updatedAt: expect.any(Date) });
  });

  it("resolves the shared GROQ_API_KEY from env for use, never a per-shop stored secret", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: BUILT_IN_PROVIDER });
    const forUse = await getAiIntegrationForUse({ prisma, shop: SHOP });
    expect(forUse).toEqual({ provider: BUILT_IN_PROVIDER, apiKey: "gsk_shared_test_key", model: BUILT_IN_MODEL });
  });

  it("never surfaces the placeholder stored apiKey in the public view", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: BUILT_IN_PROVIDER });
    const pub = await getAiIntegrationPublic({ prisma, shop: SHOP });
    expect(pub).not.toHaveProperty("apiKey");
  });

  it("switching from BYOK to built-in replaces the row (one integration per shop)", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: "anthropic", apiKey: "sk-ant-1" });
    await saveAiIntegration({ prisma, shop: SHOP, provider: BUILT_IN_PROVIDER });

    expect(prisma.__rows.size).toBe(1);
    const forUse = await getAiIntegrationForUse({ prisma, shop: SHOP });
    expect(forUse.provider).toBe(BUILT_IN_PROVIDER);
  });

  it("switching from built-in back to BYOK replaces the row cleanly", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: BUILT_IN_PROVIDER });
    await saveAiIntegration({ prisma, shop: SHOP, provider: "openai", apiKey: "sk-openai-1" });

    const forUse = await getAiIntegrationForUse({ prisma, shop: SHOP });
    expect(forUse.provider).toBe("openai");
    expect(forUse.apiKey).toBe("sk-openai-1");
  });

  it("respects the enabled/disabled toggle the same as BYOK", async () => {
    const prisma = fakePrisma();
    await saveAiIntegration({ prisma, shop: SHOP, provider: BUILT_IN_PROVIDER });
    await setAiIntegrationEnabled({ prisma, shop: SHOP, enabled: false });
    expect(await getAiIntegrationForUse({ prisma, shop: SHOP })).toBeNull();
  });
});
