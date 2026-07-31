// ═══════════════════════════════════════════════════════════════════
// Phase 4.4 — AI-assisted SEO cleanup: provider dispatch.
//
// Bring-your-own-key: the merchant's own Anthropic or OpenAI credential
// (see ai-settings.server.js) is used for every call — Importzo never
// holds or bills a shared key. Both providers are asked for the exact
// same shape ({title, description}) via each provider's structured/JSON
// output mode, so the caller never has to prompt-engineer around
// free-form prose or provider-specific formatting quirks.
//
// Uses the official SDKs (@anthropic-ai/sdk, openai) rather than raw
// fetch, per project convention for first-party provider integrations.
// ═══════════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

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

async function callAnthropic({ apiKey, model, prompt }) {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: SEO_JSON_SCHEMA } },
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
  if (!apiKey) return { ok: false, error: "No API key configured" };
  if (!product?.title && !product?.body_html && !product?.descriptionHtml) {
    return { ok: false, error: "Product has no title or description to work from" };
  }

  const prompt = buildPrompt(product);

  try {
    const raw = provider === "anthropic"
      ? await callAnthropic({ apiKey, model, prompt })
      : provider === "openai"
        ? await callOpenAI({ apiKey, model, prompt })
        : null;
    if (raw === null) return { ok: false, error: `Unknown provider "${provider}"` };

    const { title, description } = parseSeoJson(raw);
    return { ok: true, title, description };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export const __test = { buildPrompt, parseSeoJson, stripHtml, SEO_JSON_SCHEMA };
