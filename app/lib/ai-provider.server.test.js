import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAnthropicCreate = vi.fn();
const mockOpenAiCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    this.messages = { create: (...args) => mockAnthropicCreate(...args) };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function OpenAiMock() {
    this.chat = { completions: { create: (...args) => mockOpenAiCreate(...args) } };
  }),
}));

import { generateSeoCopy, __test } from "./ai-provider.server.js";

describe("buildPrompt / parseSeoJson (pure helpers)", () => {
  it("includes the product's current fields and asks for JSON", () => {
    const prompt = __test.buildPrompt({ title: "Old Title", body_html: "<p>Some <b>description</b></p>", vendor: "Acme", product_type: "Widgets", tags: "a,b" });
    expect(prompt).toContain("Old Title");
    expect(prompt).toContain("Some description"); // HTML stripped
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("Widgets");
    expect(prompt).toContain("JSON");
  });

  it("strips HTML tags from the description", () => {
    expect(__test.stripHtml("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });

  it("parses a valid title/description JSON response", () => {
    expect(__test.parseSeoJson('{"title": "New Title", "description": "New desc"}')).toEqual({
      title: "New Title", description: "New desc",
    });
  });

  it("throws on invalid JSON", () => {
    expect(() => __test.parseSeoJson("not json")).toThrow(/not valid JSON/);
  });

  it("throws when required fields are missing", () => {
    expect(() => __test.parseSeoJson('{"title": "Only title"}')).toThrow(/missing/i);
  });

  it("trims whitespace from parsed fields", () => {
    expect(__test.parseSeoJson('{"title": "  Padded  ", "description": "  also padded  "}')).toEqual({
      title: "Padded", description: "also padded",
    });
  });
});

describe("generateSeoCopy", () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAiCreate.mockReset();
  });

  it("calls Anthropic with structured JSON output and returns the suggestion", async () => {
    mockAnthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"title": "AI Title", "description": "AI description"}' }],
    });

    const result = await generateSeoCopy({
      provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5",
      product: { title: "Old", body_html: "<p>desc</p>" },
    });

    expect(result).toEqual({ ok: true, title: "AI Title", description: "AI description" });
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.output_config.format.type).toBe("json_schema");
    expect(call.output_config.format.schema).toMatchObject({ required: ["title", "description"] });
  });

  it("calls OpenAI with JSON response_format and returns the suggestion", async () => {
    mockOpenAiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"title": "GPT Title", "description": "GPT description"}' } }],
    });

    const result = await generateSeoCopy({
      provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini",
      product: { title: "Old", body_html: "<p>desc</p>" },
    });

    expect(result).toEqual({ ok: true, title: "GPT Title", description: "GPT description" });
    const call = mockOpenAiCreate.mock.calls[0][0];
    expect(call.model).toBe("gpt-4o-mini");
    expect(call.response_format).toEqual({ type: "json_object" });
  });

  it("surfaces a safety refusal as a failure rather than throwing", async () => {
    mockAnthropicCreate.mockResolvedValue({ stop_reason: "refusal", content: [] });
    const result = await generateSeoCopy({
      provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5",
      product: { title: "Old", body_html: "desc" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refus/i);
  });

  it("returns ok:false rather than throwing when the response isn't valid JSON", async () => {
    mockAnthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Sorry, I can't help with that." }],
    });
    const result = await generateSeoCopy({
      provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5",
      product: { title: "Old", body_html: "desc" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("returns ok:false for an unknown provider without calling either SDK", async () => {
    const result = await generateSeoCopy({
      provider: "bogus", apiKey: "key", model: "m",
      product: { title: "Old", body_html: "desc" },
    });
    expect(result.ok).toBe(false);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockOpenAiCreate).not.toHaveBeenCalled();
  });

  it("returns ok:false when no API key is provided", async () => {
    const result = await generateSeoCopy({ provider: "anthropic", apiKey: "", model: "m", product: { title: "x" } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/API key/i);
  });

  it("returns ok:false when the product has no usable content", async () => {
    const result = await generateSeoCopy({ provider: "anthropic", apiKey: "key", model: "m", product: {} });
    expect(result.ok).toBe(false);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("propagates the underlying SDK error message on failure", async () => {
    mockOpenAiCreate.mockRejectedValue(new Error("Incorrect API key provided"));
    const result = await generateSeoCopy({
      provider: "openai", apiKey: "bad-key", model: "gpt-4o-mini",
      product: { title: "Old", body_html: "desc" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Incorrect API key/);
  });
});
