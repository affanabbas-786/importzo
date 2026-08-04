import { describe, it, expect, vi, beforeEach } from "vitest";

const getAiIntegrationForUseMock = vi.fn();
vi.mock("./ai-settings.server", () => ({
  getAiIntegrationForUse: (...args) => getAiIntegrationForUseMock(...args),
}));

const assertAiQuotaAvailableMock = vi.fn();
const recordAiUsageMock = vi.fn();
vi.mock("./usage.server", () => ({
  assertAiQuotaAvailable: (...args) => assertAiQuotaAvailableMock(...args),
  recordAiUsage: (...args) => recordAiUsageMock(...args),
}));

const generateAltTextMock = vi.fn();
vi.mock("./ai-provider.server", () => ({
  generateAltText: (...args) => generateAltTextMock(...args),
}));

import { createAltTextGenerator } from "./alt-text.server.js";

const prisma = {};
const SHOP = "dest-shop.myshopify.com";

describe("createAltTextGenerator", () => {
  beforeEach(() => {
    getAiIntegrationForUseMock.mockReset();
    assertAiQuotaAvailableMock.mockReset();
    recordAiUsageMock.mockReset();
    generateAltTextMock.mockReset();
  });

  it("is disabled when no AI integration is configured, without checking quota", async () => {
    getAiIntegrationForUseMock.mockResolvedValue(null);
    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    expect(gen.enabled).toBe(false);
    expect(gen.generate).toBeUndefined();
    expect(assertAiQuotaAvailableMock).not.toHaveBeenCalled();
  });

  it("is enabled immediately for BYOK, without any quota check", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "anthropic", apiKey: "sk-ant", model: "claude-haiku-4-5" });
    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    expect(gen.enabled).toBe(true);
    expect(assertAiQuotaAvailableMock).not.toHaveBeenCalled();
  });

  it("is disabled at job start when groq_builtin has no eligibility/budget left", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "groq_builtin", apiKey: "gsk", model: "llama-3.1-8b-instant" });
    assertAiQuotaAvailableMock.mockResolvedValue({ ok: false, message: "no budget" });
    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    expect(gen.enabled).toBe(false);
  });

  it("generates alt text via BYOK and never touches usage tracking", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    generateAltTextMock.mockResolvedValue({ ok: true, altText: "Blue cotton t-shirt" });

    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    const alt = await gen.generate({ title: "Blue T-Shirt", description: "100% cotton" });

    expect(alt).toBe("Blue cotton t-shirt");
    expect(recordAiUsageMock).not.toHaveBeenCalled();
  });

  it("generates via groq_builtin, re-checking quota before every call and recording usage on success", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "groq_builtin", apiKey: "gsk", model: "llama-3.1-8b-instant" });
    assertAiQuotaAvailableMock.mockResolvedValue({ ok: true });
    generateAltTextMock.mockResolvedValue({ ok: true, altText: "Alt text" });

    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    await gen.generate({ title: "T", description: "D" });
    await gen.generate({ title: "T2", description: "D2" });

    expect(assertAiQuotaAvailableMock).toHaveBeenCalledTimes(3); // 1 at job start + 1 per generate() call
    expect(recordAiUsageMock).toHaveBeenCalledTimes(2);
  });

  it("stops generating mid-job once the shared budget runs out, without erroring", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "groq_builtin", apiKey: "gsk", model: "llama-3.1-8b-instant" });
    assertAiQuotaAvailableMock
      .mockResolvedValueOnce({ ok: true })  // job-start gate
      .mockResolvedValueOnce({ ok: true })  // 1st generate() call
      .mockResolvedValueOnce({ ok: false, message: "exhausted" }); // 2nd generate() call
    generateAltTextMock.mockResolvedValue({ ok: true, altText: "Alt text" });

    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    const first = await gen.generate({ title: "T1", description: "D1" });
    const second = await gen.generate({ title: "T2", description: "D2" });
    const third = await gen.generate({ title: "T3", description: "D3" }); // must not re-check quota once exhausted

    expect(first).toBe("Alt text");
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(assertAiQuotaAvailableMock).toHaveBeenCalledTimes(3); // not a 4th time for the 3rd call
    expect(generateAltTextMock).toHaveBeenCalledTimes(1); // only the successful first call reached the provider
  });

  it("is best-effort — a failed provider call returns null rather than throwing", async () => {
    getAiIntegrationForUseMock.mockResolvedValue({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" });
    generateAltTextMock.mockResolvedValue({ ok: false, error: "provider outage" });

    const gen = await createAltTextGenerator({ prisma, shop: SHOP });
    const alt = await gen.generate({ title: "T", description: "D" });
    expect(alt).toBeNull();
  });
});
