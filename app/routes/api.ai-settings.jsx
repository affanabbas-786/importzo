// Phase 4.4 — AI cleanup integration settings (bring-your-own-key).
//
// GET  /api/ai-settings                       -> { ok, integration } (never the key)
// POST /api/ai-settings  intent=save           (provider, apiKey, model)
// POST /api/ai-settings  intent=disable
// POST /api/ai-settings  intent=delete

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getAiIntegrationPublic, saveAiIntegration, setAiIntegrationEnabled, deleteAiIntegration,
  PROVIDERS, SUGGESTED_MODELS,
} from "../lib/ai-settings.server";
import { withPolicy } from "../lib/rate-limit.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const integration = await getAiIntegrationPublic({ prisma, shop: session.shop });
  return Response.json({ ok: true, integration, providers: PROVIDERS, suggestedModels: SUGGESTED_MODELS });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  return withPolicy({ policyName: "mappingTemplate", shop: session.shop }, async () => {
    if (intent === "save") {
      const result = await saveAiIntegration({
        prisma, shop: session.shop,
        provider: (formData.get("provider") || "").trim(),
        apiKey: formData.get("apiKey"),
        model: formData.get("model"),
      });
      if (!result.ok) return Response.json(result, { status: 400 });
      return Response.json({ ok: true, integration: result.integration });
    }

    if (intent === "disable" || intent === "enable") {
      const result = await setAiIntegrationEnabled({ prisma, shop: session.shop, enabled: intent === "enable" });
      if (!result.ok) return Response.json(result, { status: 404 });
      return Response.json({ ok: true, integration: result.integration });
    }

    if (intent === "delete") {
      await deleteAiIntegration({ prisma, shop: session.shop });
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
  });
};
