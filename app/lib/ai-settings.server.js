// ═══════════════════════════════════════════════════════════════════
// Phase 4.4 — AI cleanup integration settings (bring-your-own-key),
// extended in Phase 6 with Importzo's own built-in AI (Groq, Pro/Agency
// only, shared 500-call/month budget — see usage.server.js).
//
// One row per shop, covering BOTH modes: BYOK (provider = anthropic |
// openai, a real encrypted key) or built-in (provider = "groq_builtin",
// no per-shop key at all — the shared credential lives in
// process.env.GROQ_API_KEY and is never shop-specific). Re-saving
// replaces the whole row; there's no per-provider history, matching the
// equally simple SourceStore ("one source connection per shop")
// precedent. Tier/quota gating for groq_builtin is NOT this module's
// job — see usage.server.js's assertAiQuotaAvailable, called by each
// call site (api.ai-enhance.jsx etc.) before actually using the
// credential this module hands back.
// ═══════════════════════════════════════════════════════════════════

import { encrypt, decrypt } from "../utils/encryption.server";

export const PROVIDERS = Object.freeze(["anthropic", "openai"]);
export const BUILT_IN_PROVIDER = "groq_builtin";
export const ALL_PROVIDERS = Object.freeze([...PROVIDERS, BUILT_IN_PROVIDER]);

// Suggested (not enforced) defaults — cheap/fast models appropriate for
// short SEO copy, not deep reasoning. The merchant can type any model
// string; this only pre-fills the settings form.
export const SUGGESTED_MODELS = Object.freeze({
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
});

// Fixed — the built-in mode has no per-shop model field to edit (unlike
// BYOK above), since Importzo picks the model, not the merchant. Chosen
// for cost/speed given the shared, capped monthly budget; see
// ai-provider.server.js.
export const BUILT_IN_MODEL = "llama-3.1-8b-instant";

/** Public-safe view: never includes the key itself. */
function toPublic(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.provider === BUILT_IN_PROVIDER ? BUILT_IN_MODEL : (row.model || SUGGESTED_MODELS[row.provider] || null),
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

export async function getAiIntegrationPublic({ prisma, shop }) {
  const row = await prisma.aiIntegration.findUnique({ where: { shop } });
  return toPublic(row);
}

/**
 * Internal use only (calling the provider) — includes the decrypted key
 * for BYOK, or the shared built-in key from env for groq_builtin. Callers
 * still owe a tier/quota check via usage.server.js's
 * assertAiQuotaAvailable before spending a groq_builtin credential — this
 * function only resolves *which* credential the shop has configured, it
 * doesn't gate anything.
 */
export async function getAiIntegrationForUse({ prisma, shop }) {
  const row = await prisma.aiIntegration.findUnique({ where: { shop } });
  if (!row || !row.enabled) return null;
  if (row.provider === BUILT_IN_PROVIDER) {
    return { provider: BUILT_IN_PROVIDER, apiKey: process.env.GROQ_API_KEY || null, model: BUILT_IN_MODEL }; // eslint-disable-line no-undef
  }
  return {
    provider: row.provider,
    apiKey: decrypt(row.apiKey),
    model: row.model || SUGGESTED_MODELS[row.provider],
  };
}

export async function saveAiIntegration({ prisma, shop, provider, apiKey, model }) {
  if (!ALL_PROVIDERS.includes(provider)) {
    return { ok: false, error: `Unknown provider "${provider}". Must be one of: ${ALL_PROVIDERS.join(", ")}` };
  }

  // Built-in mode has no per-shop secret to store — the shared key lives in
  // process.env.GROQ_API_KEY, resolved at call time, never persisted here.
  // A fixed placeholder keeps the `apiKey` column (used for every other
  // provider) satisfied without a schema change, and is never decrypted
  // for use — getAiIntegrationForUse short-circuits before touching it.
  if (provider === BUILT_IN_PROVIDER) {
    const row = await prisma.aiIntegration.upsert({
      where: { shop },
      create: { shop, provider, apiKey: encrypt("built-in"), model: BUILT_IN_MODEL, enabled: true },
      update: { provider, apiKey: encrypt("built-in"), model: BUILT_IN_MODEL, enabled: true },
    });
    return { ok: true, integration: toPublic(row) };
  }

  const trimmedKey = (apiKey || "").trim();
  if (!trimmedKey) {
    return { ok: false, error: "API key is required" };
  }

  const data = {
    shop,
    provider,
    apiKey: encrypt(trimmedKey),
    model: (model || "").trim() || null,
    enabled: true,
  };
  const row = await prisma.aiIntegration.upsert({
    where: { shop },
    create: data,
    update: { provider: data.provider, apiKey: data.apiKey, model: data.model, enabled: true },
  });
  return { ok: true, integration: toPublic(row) };
}

export async function setAiIntegrationEnabled({ prisma, shop, enabled }) {
  const existing = await prisma.aiIntegration.findUnique({ where: { shop } });
  if (!existing) return { ok: false, error: "No AI integration configured for this shop" };
  const row = await prisma.aiIntegration.update({ where: { shop }, data: { enabled: !!enabled } });
  return { ok: true, integration: toPublic(row) };
}

export async function deleteAiIntegration({ prisma, shop }) {
  await prisma.aiIntegration.deleteMany({ where: { shop } });
  return { ok: true };
}
