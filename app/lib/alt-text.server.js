// ═══════════════════════════════════════════════════════════════════
// Phase 6 — image alt-text auto-generation: per-job orchestration.
//
// Resolves the shop's AI integration and (for groq_builtin) the tier/
// quota gate ONCE per import/transfer job, then hands back a cheap
// per-image `generate()` call — so a 500-product job doesn't repeat "is
// this shop eligible" checks 500 times, and a job that runs out of
// shared budget partway through stops spending it (rather than either
// failing the whole job or silently ignoring the cap) without stopping
// the import itself — a missing alt text is never worth failing a
// product create/update over.
// ═══════════════════════════════════════════════════════════════════

import { getAiIntegrationForUse } from "./ai-settings.server";
import { assertAiQuotaAvailable, recordAiUsage } from "./usage.server";
import { generateAltText } from "./ai-provider.server";

/**
 * @returns {{ enabled: boolean, generate?: (args: {title, description}) => Promise<string|null> }}
 * `enabled: false` (no `generate`) when no AI integration is configured,
 * or a groq_builtin shop has no eligibility/budget left at job start —
 * callers should just skip alt-text generation entirely in that case,
 * exactly as if the opt-in toggle were off.
 */
export async function createAltTextGenerator({ prisma, shop }) {
  const integration = await getAiIntegrationForUse({ prisma, shop });
  if (!integration) return { enabled: false };

  if (integration.provider === "groq_builtin") {
    const gate = await assertAiQuotaAvailable({ prisma, shop });
    if (!gate.ok) return { enabled: false };
  }

  let exhausted = false;

  async function generate({ title, description }) {
    if (exhausted) return null;

    if (integration.provider === "groq_builtin") {
      // Re-checked before EVERY call, not just once at job start — a long
      // job can burn through the shared cap partway through.
      const gate = await assertAiQuotaAvailable({ prisma, shop });
      if (!gate.ok) { exhausted = true; return null; }
    }

    const result = await generateAltText({
      provider: integration.provider, apiKey: integration.apiKey, model: integration.model,
      title, description,
    });
    if (!result.ok) return null; // best-effort — a failed generation just leaves the image alt-less

    if (integration.provider === "groq_builtin") {
      await recordAiUsage({ prisma, shop });
    }
    return result.altText;
  }

  return { enabled: true, generate };
}
