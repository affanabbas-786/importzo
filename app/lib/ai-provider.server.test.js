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

import OpenAI from "openai";
import { generateSeoCopy, explainError, generateAltText, detectSimilarProducts, __test } from "./ai-provider.server.js";

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

  it("gives a built-in-AI-specific message (not \"No API key configured\") when groq_builtin has no key", async () => {
    const result = await generateSeoCopy({
      provider: "groq_builtin", apiKey: "", model: "llama-3.1-8b-instant",
      product: { title: "Old", body_html: "desc" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/built-in AI is temporarily unavailable/i);
    expect(result.error).not.toMatch(/No API key configured/);
  });
});

describe("generateSeoCopy — groq_builtin", () => {
  beforeEach(() => {
    mockOpenAiCreate.mockReset();
    OpenAI.mockClear();
  });

  it("calls Groq via the OpenAI-compatible client with JSON response_format", async () => {
    mockOpenAiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"title": "Groq Title", "description": "Groq description"}' } }],
    });

    const result = await generateSeoCopy({
      provider: "groq_builtin", apiKey: "gsk_test", model: "llama-3.1-8b-instant",
      product: { title: "Old", body_html: "<p>desc</p>" },
    });

    expect(result).toEqual({ ok: true, title: "Groq Title", description: "Groq description" });
    const call = mockOpenAiCreate.mock.calls[0][0];
    expect(call.model).toBe("llama-3.1-8b-instant");
    expect(call.response_format).toEqual({ type: "json_object" });
  });

  it("points the OpenAI-compatible client at Groq's endpoint, not OpenAI's", async () => {
    mockOpenAiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"title": "T", "description": "D"}' } }],
    });
    await generateSeoCopy({
      provider: "groq_builtin", apiKey: "gsk_test", model: "llama-3.1-8b-instant",
      product: { title: "Old", body_html: "desc" },
    });
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://api.groq.com/openai/v1" }));
  });

  it("propagates a Groq SDK error as a failure rather than throwing", async () => {
    mockOpenAiCreate.mockRejectedValue(new Error("rate limit exceeded"));
    const result = await generateSeoCopy({
      provider: "groq_builtin", apiKey: "gsk_test", model: "llama-3.1-8b-instant",
      product: { title: "Old", body_html: "desc" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rate limit exceeded/);
  });
});

describe("buildErrorDiagnosisPrompt / parseErrorDiagnosisJson (pure helpers)", () => {
  it("includes the raw error and item label, and asks for JSON", () => {
    const prompt = __test.buildErrorDiagnosisPrompt({ errorMessage: "GraphQL userErrors: Variant SKU has already been taken", itemLabel: "Blue T-Shirt" });
    expect(prompt).toContain("Blue T-Shirt");
    expect(prompt).toContain("Variant SKU has already been taken");
    expect(prompt).toContain("JSON");
  });

  it("omits the item line entirely when no label is given", () => {
    const prompt = __test.buildErrorDiagnosisPrompt({ errorMessage: "some error", itemLabel: "" });
    expect(prompt).not.toContain("Item:");
  });

  it("parses a valid explanation JSON response", () => {
    expect(__test.parseErrorDiagnosisJson('{"explanation": "The SKU already exists on another product. Use a unique SKU or enable overwrite mode."}'))
      .toEqual({ explanation: "The SKU already exists on another product. Use a unique SKU or enable overwrite mode." });
  });

  it("throws on invalid JSON", () => {
    expect(() => __test.parseErrorDiagnosisJson("not json")).toThrow(/not valid JSON/);
  });

  it("throws when the explanation field is missing or empty", () => {
    expect(() => __test.parseErrorDiagnosisJson("{}")).toThrow(/missing/i);
    expect(() => __test.parseErrorDiagnosisJson('{"explanation": "  "}')).toThrow(/missing/i);
  });
});

describe("explainError", () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAiCreate.mockReset();
  });

  it("calls the configured BYOK provider and returns the explanation", async () => {
    mockAnthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"explanation": "This SKU already exists on another product — use a unique SKU or turn on overwrite mode."}' }],
    });
    const result = await explainError({
      provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5",
      errorMessage: "Variant SKU has already been taken", itemLabel: "Blue T-Shirt",
    });
    expect(result).toEqual({ ok: true, explanation: "This SKU already exists on another product — use a unique SKU or turn on overwrite mode." });
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.output_config.format.schema).toMatchObject({ required: ["explanation"] });
  });

  it("calls groq_builtin the same way as SEO copy does", async () => {
    mockOpenAiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"explanation": "The store rejected the request because required scope read_customers is missing."}' } }],
    });
    const result = await explainError({
      provider: "groq_builtin", apiKey: "gsk_test", model: "llama-3.1-8b-instant",
      errorMessage: "403 Forbidden: missing scope read_customers",
    });
    expect(result.ok).toBe(true);
    expect(result.explanation).toMatch(/read_customers/);
  });

  it("returns ok:false when no error message is given", async () => {
    const result = await explainError({ provider: "anthropic", apiKey: "key", model: "m", errorMessage: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No error message/);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("returns the built-in-AI-specific message when groq_builtin has no key", async () => {
    const result = await explainError({ provider: "groq_builtin", apiKey: "", model: "m", errorMessage: "some error" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/built-in AI is temporarily unavailable/i);
  });

  it("never applies or retries anything — purely returns text", async () => {
    // There is no "apply" concept for error diagnosis (unlike SEO copy's
    // apply step) — this test documents that explainError's return shape
    // has no side-effecting fields (no productId, no mutation payload).
    mockAnthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"explanation": "Explanation text."}' }],
    });
    const result = await explainError({ provider: "anthropic", apiKey: "k", model: "m", errorMessage: "err" });
    expect(Object.keys(result).sort()).toEqual(["explanation", "ok"]);
  });
});

describe("buildAltTextPrompt / parseAltTextJson (pure helpers)", () => {
  it("includes title and stripped description, and asks for JSON", () => {
    const prompt = __test.buildAltTextPrompt({ title: "Blue Cotton T-Shirt", description: "<p>A <b>soft</b> cotton tee</p>" });
    expect(prompt).toContain("Blue Cotton T-Shirt");
    expect(prompt).toContain("A soft cotton tee");
    expect(prompt).toContain("JSON");
  });

  it("omits the description line when none is given", () => {
    const prompt = __test.buildAltTextPrompt({ title: "T", description: "" });
    expect(prompt).not.toContain("Product description:");
  });

  it("parses a valid altText JSON response", () => {
    expect(__test.parseAltTextJson('{"altText": "Blue cotton crewneck t-shirt"}')).toEqual({ altText: "Blue cotton crewneck t-shirt" });
  });

  it("throws when altText is missing or empty", () => {
    expect(() => __test.parseAltTextJson("{}")).toThrow(/missing/i);
    expect(() => __test.parseAltTextJson('{"altText": "   "}')).toThrow(/missing/i);
  });
});

describe("generateAltText", () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAiCreate.mockReset();
  });

  it("calls the configured provider and returns alt text", async () => {
    mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: '{"altText": "Blue cotton crewneck t-shirt, folded flat"}' } }] });
    const result = await generateAltText({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini", title: "Blue T-Shirt", description: "100% cotton" });
    expect(result).toEqual({ ok: true, altText: "Blue cotton crewneck t-shirt, folded flat" });
  });

  it("returns ok:false when there's no title or description to work from", async () => {
    const result = await generateAltText({ provider: "openai", apiKey: "key", model: "m", title: "", description: "" });
    expect(result.ok).toBe(false);
    expect(mockOpenAiCreate).not.toHaveBeenCalled();
  });

  it("works with groq_builtin the same as every other built-in-AI feature", async () => {
    mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: '{"altText": "Alt text"}' } }] });
    const result = await generateAltText({ provider: "groq_builtin", apiKey: "gsk_test", model: "llama-3.1-8b-instant", title: "T", description: "D" });
    expect(result.ok).toBe(true);
  });
});

describe("buildSimilarityPrompt / parseSimilarityJson (pure helpers)", () => {
  it("includes both title lists and asks for JSON", () => {
    const prompt = __test.buildSimilarityPrompt({ incomingTitles: ["Blue Tee"], existingTitles: ["Blue T-Shirt"] });
    expect(prompt).toContain("Blue Tee");
    expect(prompt).toContain("Blue T-Shirt");
    expect(prompt).toContain("JSON");
  });

  it("parses a valid matches array", () => {
    expect(__test.parseSimilarityJson('{"matches": [{"incomingTitle": "Blue Tee", "existingTitle": "Blue T-Shirt"}]}')).toEqual({
      matches: [{ incomingTitle: "Blue Tee", existingTitle: "Blue T-Shirt" }],
    });
  });

  it("parses an empty matches array (the expected common case)", () => {
    expect(__test.parseSimilarityJson('{"matches": []}')).toEqual({ matches: [] });
  });

  it("throws when matches is missing or not an array", () => {
    expect(() => __test.parseSimilarityJson("{}")).toThrow(/missing the matches array/i);
    expect(() => __test.parseSimilarityJson('{"matches": "not an array"}')).toThrow(/missing the matches array/i);
  });

  it("silently drops malformed entries rather than throwing on one bad match", () => {
    expect(__test.parseSimilarityJson('{"matches": [{"incomingTitle": "A", "existingTitle": "B"}, {"incomingTitle": "C"}, null]}')).toEqual({
      matches: [{ incomingTitle: "A", existingTitle: "B" }],
    });
  });
});

describe("detectSimilarProducts", () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAiCreate.mockReset();
  });

  it("calls the configured provider and returns matches", async () => {
    mockOpenAiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"matches": [{"incomingTitle": "Blue Tee", "existingTitle": "Blue T-Shirt"}]}' } }],
    });
    const result = await detectSimilarProducts({
      provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini",
      incomingTitles: ["Blue Tee", "Red Hat"], existingTitles: ["Blue T-Shirt", "Green Scarf"],
    });
    expect(result).toEqual({ ok: true, matches: [{ incomingTitle: "Blue Tee", existingTitle: "Blue T-Shirt" }] });
  });

  it("short-circuits to an empty match list without calling the provider when either list is empty", async () => {
    const result = await detectSimilarProducts({ provider: "openai", apiKey: "key", model: "m", incomingTitles: [], existingTitles: ["X"] });
    expect(result).toEqual({ ok: true, matches: [] });
    expect(mockOpenAiCreate).not.toHaveBeenCalled();

    const result2 = await detectSimilarProducts({ provider: "openai", apiKey: "key", model: "m", incomingTitles: ["X"], existingTitles: [] });
    expect(result2).toEqual({ ok: true, matches: [] });
    expect(mockOpenAiCreate).not.toHaveBeenCalled();
  });

  it("caps both lists at MAX_TITLES_PER_LIST before building the prompt", async () => {
    mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: '{"matches": []}' } }] });
    const many = Array.from({ length: __test.MAX_TITLES_PER_LIST + 50 }, (_, i) => `Product ${i}`);
    await detectSimilarProducts({ provider: "openai", apiKey: "key", model: "m", incomingTitles: many, existingTitles: many });

    const sentPrompt = mockOpenAiCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).not.toContain(`Product ${__test.MAX_TITLES_PER_LIST}`); // first title past the cap
    expect(sentPrompt).toContain(`Product ${__test.MAX_TITLES_PER_LIST - 1}`); // last title within the cap
  });

  it("works with groq_builtin the same as every other built-in-AI feature", async () => {
    mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: '{"matches": []}' } }] });
    const result = await detectSimilarProducts({
      provider: "groq_builtin", apiKey: "gsk_test", model: "llama-3.1-8b-instant",
      incomingTitles: ["A"], existingTitles: ["B"],
    });
    expect(result.ok).toBe(true);
  });

  it("propagates a provider error as a failure rather than throwing", async () => {
    mockOpenAiCreate.mockRejectedValue(new Error("rate limited"));
    const result = await detectSimilarProducts({ provider: "openai", apiKey: "key", model: "m", incomingTitles: ["A"], existingTitles: ["B"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rate limited/);
  });
});
