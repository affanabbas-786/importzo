// ═══════════════════════════════════════════════════════════════════
// Phase 4.4 — AI cleanup integration settings (bring-your-own-key).
//
// One row per shop. The merchant's API key is AES-encrypted at rest via
// the same encrypt()/decrypt() Phase 3.1 hardened for OAuth tokens — this
// is exactly the "new third-party credential" case that module exists
// for. Re-saving replaces provider/key/model; there's no per-provider
// history, matching the equally simple SourceStore ("one source
// connection per shop") precedent.
// ═══════════════════════════════════════════════════════════════════

import { encrypt, decrypt } from "../utils/encryption.server";

export const PROVIDERS = Object.freeze(["anthropic", "openai"]);

// Suggested (not enforced) defaults — cheap/fast models appropriate for
// short SEO copy, not deep reasoning. The merchant can type any model
// string; this only pre-fills the settings form.
export const SUGGESTED_MODELS = Object.freeze({
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
});

/** Public-safe view: never includes the key itself. */
function toPublic(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.model || SUGGESTED_MODELS[row.provider] || null,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

export async function getAiIntegrationPublic({ prisma, shop }) {
  const row = await prisma.aiIntegration.findUnique({ where: { shop } });
  return toPublic(row);
}

/** Internal use only (calling the provider) — includes the decrypted key. */
export async function getAiIntegrationForUse({ prisma, shop }) {
  const row = await prisma.aiIntegration.findUnique({ where: { shop } });
  if (!row || !row.enabled) return null;
  return {
    provider: row.provider,
    apiKey: decrypt(row.apiKey),
    model: row.model || SUGGESTED_MODELS[row.provider],
  };
}

export async function saveAiIntegration({ prisma, shop, provider, apiKey, model }) {
  if (!PROVIDERS.includes(provider)) {
    return { ok: false, error: `Unknown provider "${provider}". Must be one of: ${PROVIDERS.join(", ")}` };
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
