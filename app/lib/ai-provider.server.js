// ═══════════════════════════════════════════════════════════════════
// Phase 4.4 — AI-assisted SEO cleanup: provider dispatch.
// Phase 6 — adds "groq_builtin", Importzo's own capped/gated built-in
// option (see ai-settings.server.js, usage.server.js).
//
// Bring-your-own-key: the merchant's own Anthropic or OpenAI credential
// (see ai-settings.server.js) is used for every call — Importzo never
// holds or bills a shared key for those two. Built-in mode instead uses
// Importzo's own Groq credential (process.env.GROQ_API_KEY), gated by
// tier + a shared monthly cap enforced by the caller before this module
// is ever reached. All three providers are asked for the exact same
// shape ({title, description}) via each provider's structured/JSON
// output mode, so the caller never has to prompt-engineer around
// free-form prose or provider-specific formatting quirks.
//
// Uses the official SDKs (@anthropic-ai/sdk, openai) rather than raw
// fetch, per project convention for first-party provider integrations.
// Groq exposes an OpenAI-compatible Chat Completions endpoint, so it
// reuses the `openai` package pointed at Groq's base URL instead of
// pulling in a separate SDK for one provider.
// ═══════════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const MAX_TITLE_INPUT = 300;
const MAX_DESCRIPTION_INPUT = 4000; // descriptionHtml can be large; cap what we send

const SEO_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
  },
  required: ["title", "description"],
  additionalProperties: false,
};

function stripHtml(html) {
  return (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildPrompt(product) {
  const title = (product.title || "").slice(0, MAX_TITLE_INPUT);
  const description = stripHtml(product.body_html || product.descriptionHtml || "").slice(0, MAX_DESCRIPTION_INPUT);
  const vendor = product.vendor || "";
  const productType = product.product_type || product.productType || "";
  const tags = Array.isArray(product.tags) ? product.tags.join(", ") : (product.tags || "");

  return [
    "You are an SEO copywriter for a Shopify store. Rewrite this product's title and meta description",
    "for search-engine visibility and click-through, while staying accurate to the product.",
    "",
    `Current title: ${title || "(none)"}`,
    `Current description: ${description || "(none)"}`,
    vendor ? `Vendor: ${vendor}` : null,
    productType ? `Product type: ${productType}` : null,
    tags ? `Tags: ${tags}` : null,
    "",
    "Rules:",
    "- title: 40-60 characters, no marketing fluff like \"Buy now\" or excessive punctuation.",
    "- description: 120-155 characters, plain text (no HTML), written for a search-result snippet.",
    "- Do not invent product attributes, materials, or claims not implied by the input.",
    "- Respond with a JSON object containing exactly two fields: \"title\" and \"description\".",
  ].filter(Boolean).join("\n");
}

async function callAnthropic({ apiKey, model, prompt, schema }) {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("The AI provider declined this request (safety refusal).");
  }
  const textBlock = (response.content || []).find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("AI provider returned no text content");
  return textBlock.text;
}

async function callOpenAI({ apiKey, model, prompt }) {
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI provider returned no content");
  return text;
}

async function callGroq({ apiKey, model, prompt }) {
  if (!apiKey) throw new Error("Built-in AI is not configured on this server (missing GROQ_API_KEY)");
  const client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI provider returned no content");
  return text;
}

// Shared dispatch used by every AI-backed feature (SEO copy, error
// diagnosis, ...). `schema` is only meaningful to Anthropic's structured
// output mode — OpenAI/Groq both use generic json_object mode and infer
// the shape from the prompt's own instructions instead.
async function callProvider({ provider, apiKey, model, prompt, schema }) {
  if (provider === "anthropic") return callAnthropic({ apiKey, model, prompt, schema });
  if (provider === "openai") return callOpenAI({ apiKey, model, prompt });
  if (provider === "groq_builtin") return callGroq({ apiKey, model, prompt });
  return null;
}

function parseSeoJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI provider response was not valid JSON");
  }
  if (typeof parsed?.title !== "string" || typeof parsed?.description !== "string") {
    throw new Error("AI provider response was missing title/description fields");
  }
  return { title: parsed.title.trim(), description: parsed.description.trim() };
}

/**
 * Generates an SEO title/description suggestion for a product. Never
 * applies anything — purely a suggestion the caller reviews and, if
 * accepted, writes back via productUpdate itself.
 *
 * `product` accepts either the CSV-import shape (title/body_html/...) or
 * the GraphQL shape (title/descriptionHtml/productType/...).
 */
export async function generateSeoCopy({ provider, apiKey, model, product }) {
  if (!apiKey) {
    return {
      ok: false,
      error: provider === "groq_builtin"
        ? "Importzo's built-in AI is temporarily unavailable. Please connect your own Anthropic or OpenAI key instead."
        : "No API key configured",
    };
  }
  if (!product?.title && !product?.body_html && !product?.descriptionHtml) {
    return { ok: false, error: "Product has no title or description to work from" };
  }

  const prompt = buildPrompt(product);

  try {
    const raw = await callProvider({ provider, apiKey, model, prompt, schema: SEO_JSON_SCHEMA });
    if (raw === null) return { ok: false, error: `Unknown provider "${provider}"` };

    const { title, description } = parseSeoJson(raw);
    return { ok: true, title, description };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 6 — image alt-text generation.
//
// Generates SEO-friendly alt text for a product image that doesn't have
// any, from the product's title/description only (the image URL itself
// is never sent to the provider — no vision call, just text-from-text,
// which is cheap/fast and works with every provider this app supports).
// Opt-in per shop (see alt-text.server.js) and, for groq_builtin, gated
// and metered exactly like every other built-in-AI feature.
// ═══════════════════════════════════════════════════════════════════

const ALT_TEXT_SCHEMA = {
  type: "object",
  properties: { altText: { type: "string" } },
  required: ["altText"],
  additionalProperties: false,
};

function buildAltTextPrompt({ title, description }) {
  return [
    "Write concise, descriptive alt text for a Shopify product's image, for accessibility and SEO.",
    "You are not shown the image itself — base the alt text only on the product information below.",
    "",
    `Product title: ${title || "(none)"}`,
    description ? `Product description: ${stripHtml(description).slice(0, 500)}` : null,
    "",
    "Rules:",
    "- Under 125 characters.",
    "- Describe the product itself, not the fact that it's a photo (no \"Image of\" / \"Photo of\").",
    "- Do not invent visual details (color, material, setting) that aren't implied by the title/description.",
    "- Respond with a JSON object containing exactly one field: \"altText\".",
  ].filter(Boolean).join("\n");
}

function parseAltTextJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI provider response was not valid JSON");
  }
  if (typeof parsed?.altText !== "string" || !parsed.altText.trim()) {
    throw new Error("AI provider response was missing the altText field");
  }
  return { altText: parsed.altText.trim() };
}

/** Generates alt text for one image from product title/description alone. */
export async function generateAltText({ provider, apiKey, model, title, description }) {
  if (!apiKey) {
    return {
      ok: false,
      error: provider === "groq_builtin"
        ? "Importzo's built-in AI is temporarily unavailable. Please connect your own Anthropic or OpenAI key instead."
        : "No API key configured",
    };
  }
  if (!title && !description) return { ok: false, error: "No product title or description to work from" };

  const prompt = buildAltTextPrompt({ title, description });

  try {
    const raw = await callProvider({ provider, apiKey, model, prompt, schema: ALT_TEXT_SCHEMA });
    if (raw === null) return { ok: false, error: `Unknown provider "${provider}"` };

    const { altText } = parseAltTextJson(raw);
    return { ok: true, altText };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 6 — plain-language error diagnosis.
//
// Takes a raw error string (from a failed import/transfer row) and asks
// the configured provider for a short, non-technical explanation + fix.
// Same three-provider dispatch as generateSeoCopy — BYOK or built-in,
// caller (api.ai-diagnose-error.jsx) owns the tier/quota gate for
// groq_builtin, same as every other built-in-AI call site.
// ═══════════════════════════════════════════════════════════════════

const MAX_ERROR_INPUT = 1000; // raw error strings are sometimes a full stack/response dump

const ERROR_DIAGNOSIS_SCHEMA = {
  type: "object",
  properties: { explanation: { type: "string" } },
  required: ["explanation"],
  additionalProperties: false,
};

function buildErrorDiagnosisPrompt({ errorMessage, itemLabel }) {
  return [
    "You are a support engineer explaining a Shopify data-import/transfer failure to a merchant who is not",
    "a developer. Given the raw error below, explain in 1-2 short sentences what most likely went wrong, in",
    "plain language, and suggest one concrete fix or next step.",
    "",
    itemLabel ? `Item: ${itemLabel}` : null,
    `Raw error: ${errorMessage}`,
    "",
    "Rules:",
    "- Plain language only — no jargon, no code, no stack traces, no field/API names unless the merchant would",
    "  recognize them (e.g. \"SKU\" and \"price\" are fine, \"GraphQL\" and \"userErrors\" are not).",
    "- Be concrete and specific to this error — do not give generic troubleshooting advice.",
    "- If the cause genuinely can't be determined from the error text alone, say that plainly instead of guessing.",
    "- Respond with a JSON object containing exactly one field: \"explanation\".",
  ].filter(Boolean).join("\n");
}

function parseErrorDiagnosisJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI provider response was not valid JSON");
  }
  if (typeof parsed?.explanation !== "string" || !parsed.explanation.trim()) {
    throw new Error("AI provider response was missing the explanation field");
  }
  return { explanation: parsed.explanation.trim() };
}

/**
 * Explains a single failed row's error in plain language. Never retries
 * the failed operation itself — purely explanatory, same "suggest, never
 * act" boundary as generateSeoCopy.
 */
export async function explainError({ provider, apiKey, model, errorMessage, itemLabel }) {
  if (!apiKey) {
    return {
      ok: false,
      error: provider === "groq_builtin"
        ? "Importzo's built-in AI is temporarily unavailable. Please connect your own Anthropic or OpenAI key instead."
        : "No API key configured",
    };
  }
  if (!errorMessage || !String(errorMessage).trim()) {
    return { ok: false, error: "No error message to explain" };
  }

  const prompt = buildErrorDiagnosisPrompt({
    errorMessage: String(errorMessage).slice(0, MAX_ERROR_INPUT),
    itemLabel: itemLabel ? String(itemLabel).slice(0, 200) : "",
  });

  try {
    const raw = await callProvider({ provider, apiKey, model, prompt, schema: ERROR_DIAGNOSIS_SCHEMA });
    if (raw === null) return { ok: false, error: `Unknown provider "${provider}"` };

    const { explanation } = parseErrorDiagnosisJson(raw);
    return { ok: true, explanation };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 6 — fuzzy duplicate/similar-product detection.
//
// Compares a batch of incoming (about-to-be-transferred) product titles
// against a batch of the destination store's existing product titles, in
// ONE request — not one call per product — and asks the provider which
// pairs are very likely the same underlying product. Deliberately not
// embeddings/vector search (per product decision): a single prompt asking
// an LLM to compare two bounded lists of plain text is simpler to reason
// about, ship, and keep within the shared monthly call budget, at the
// cost of being bounded by how many titles fit in one prompt — see the
// caller (app.transfer.jsx) for the list-size caps.
// ═══════════════════════════════════════════════════════════════════

const MAX_TITLES_PER_LIST = 200; // bounds prompt size; caller is expected to cap before calling

const SIMILARITY_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          incomingTitle: { type: "string" },
          existingTitle: { type: "string" },
        },
        required: ["incomingTitle", "existingTitle"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
};

function buildSimilarityPrompt({ incomingTitles, existingTitles }) {
  return [
    "You are comparing two lists of Shopify product titles: products about to be imported/transferred (\"incoming\"),",
    "and products that already exist in the destination store (\"existing\"). Identify pairs that are very likely",
    "the SAME underlying product — e.g. identical apart from capitalization, punctuation, minor wording, or a",
    "variant/year suffix like \"- Blue\" or \"(2024)\" — not merely similar or related products.",
    "",
    "Incoming titles:",
    JSON.stringify(incomingTitles),
    "",
    "Existing titles:",
    JSON.stringify(existingTitles),
    "",
    "Rules:",
    "- Only include a pair if you are reasonably confident it's the same product.",
    "- Sharing a category or a single common word (e.g. both containing \"T-Shirt\") is not enough on its own.",
    "- If there are no confident matches, return an empty array — that is the expected common case.",
    "- Respond with a JSON object: { \"matches\": [{ \"incomingTitle\": ..., \"existingTitle\": ... }] }.",
  ].join("\n");
}

function parseSimilarityJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI provider response was not valid JSON");
  }
  if (!Array.isArray(parsed?.matches)) {
    throw new Error("AI provider response was missing the matches array");
  }
  return {
    matches: parsed.matches.filter((m) => m && typeof m.incomingTitle === "string" && typeof m.existingTitle === "string"),
  };
}

/**
 * Flags likely duplicate products between an incoming batch and the
 * destination store's existing catalog. Purely advisory — never blocks or
 * changes a transfer itself; the caller surfaces `matches` as warnings for
 * the merchant to act on (skip / create anyway / merge).
 */
export async function detectSimilarProducts({ provider, apiKey, model, incomingTitles, existingTitles }) {
  if (!apiKey) {
    return {
      ok: false,
      error: provider === "groq_builtin"
        ? "Importzo's built-in AI is temporarily unavailable. Please connect your own Anthropic or OpenAI key instead."
        : "No API key configured",
    };
  }
  const incoming = (incomingTitles || []).filter(Boolean).slice(0, MAX_TITLES_PER_LIST);
  const existing = (existingTitles || []).filter(Boolean).slice(0, MAX_TITLES_PER_LIST);
  if (!incoming.length || !existing.length) return { ok: true, matches: [] };

  const prompt = buildSimilarityPrompt({ incomingTitles: incoming, existingTitles: existing });

  try {
    const raw = await callProvider({ provider, apiKey, model, prompt, schema: SIMILARITY_SCHEMA });
    if (raw === null) return { ok: false, error: `Unknown provider "${provider}"` };

    const { matches } = parseSimilarityJson(raw);
    return { ok: true, matches };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export const __test = {
  buildPrompt, parseSeoJson, stripHtml, SEO_JSON_SCHEMA,
  buildErrorDiagnosisPrompt, parseErrorDiagnosisJson,
  buildAltTextPrompt, parseAltTextJson,
  buildSimilarityPrompt, parseSimilarityJson, MAX_TITLES_PER_LIST,
};
