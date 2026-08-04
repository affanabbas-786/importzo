// Phase 6 — plain-language error diagnosis for failed import/transfer rows.
//
// POST /api/ai-diagnose-error  (error, itemLabel?)  -> { ok, explanation }
//
// Read-only: explains a failure, never retries or modifies anything. Uses
// whichever AI integration (BYOK or Importzo's built-in Groq) the shop has
// configured — same credential resolution as api.ai-enhance.jsx. A
// groq_builtin call is tier/quota-gated and spends from the same shared
// monthly budget as every other built-in-AI feature.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAiIntegrationForUse } from "../lib/ai-settings.server";
import { explainError } from "../lib/ai-provider.server";
import { withPolicy } from "../lib/rate-limit.server";
import { assertAiQuotaAvailable, recordAiUsage } from "../lib/usage.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const errorMessage = (formData.get("error") || "").trim();
  const itemLabel = (formData.get("itemLabel") || "").trim();

  if (!errorMessage) return Response.json({ ok: false, error: "Missing error" }, { status: 400 });

  return withPolicy({ policyName: "aiEnhance", shop: session.shop }, async () => {
    const integration = await getAiIntegrationForUse({ prisma, shop: session.shop });
    if (!integration) {
      return Response.json({
        ok: false,
        error: "No AI integration configured. Add your Anthropic or OpenAI API key — or turn on Importzo's built-in AI — in Settings first.",
      }, { status: 400 });
    }

    if (integration.provider === "groq_builtin") {
      const quotaGate = await assertAiQuotaAvailable({ prisma, shop: session.shop });
      if (!quotaGate.ok) return Response.json({ ok: false, error: quotaGate.message }, { status: 403 });
    }

    const result = await explainError({
      provider: integration.provider,
      apiKey: integration.apiKey,
      model: integration.model,
      errorMessage,
      itemLabel,
    });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 502 });

    if (integration.provider === "groq_builtin") {
      await recordAiUsage({ prisma, shop: session.shop });
    }

    return Response.json({ ok: true, explanation: result.explanation });
  });
};
