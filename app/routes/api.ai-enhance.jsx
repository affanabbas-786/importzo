// Phase 4.4 — AI-assisted SEO cleanup: optional post-import enhancement.
//
// POST /api/ai-enhance  intent=suggest  (productId)          -> { ok, title, description }
// POST /api/ai-enhance  intent=apply    (productId, title, description) -> productUpdate
//
// "suggest" never writes anything — the merchant reviews the suggestion
// and explicitly triggers "apply", which is a plain productUpdate call
// scoped to only title/descriptionHtml (never touches price, inventory,
// variants, or anything else about the product).

import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { getAiIntegrationForUse } from "../lib/ai-settings.server";
import { generateSeoCopy } from "../lib/ai-provider.server";
import { withPolicy } from "../lib/rate-limit.server";
import { assertAiQuotaAvailable, recordAiUsage } from "../lib/usage.server";

const PRODUCT_FIELDS_QUERY = `#graphql
  query AiEnhanceProduct($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      vendor
      productType
      tags
    }
  }`;

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation AiEnhanceProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title descriptionHtml }
      userErrors { field message }
    }
  }`;

function toProductGid(productId) {
  return String(productId).startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const version = apiVersion || "2025-10";
  const productId = (formData.get("productId") || "").trim();
  if (!productId) return Response.json({ ok: false, error: "Missing productId" }, { status: 400 });
  const gid = toProductGid(productId);

  if (intent === "suggest") {
    return withPolicy({ policyName: "aiEnhance", shop: session.shop }, async () => {
      const integration = await getAiIntegrationForUse({ prisma, shop: session.shop });
      if (!integration) {
        return Response.json({
          ok: false,
          error: "No AI integration configured. Add your Anthropic or OpenAI API key in Settings first.",
        }, { status: 400 });
      }

      // Built-in (Groq) is tier-gated + shares a monthly cap with every
      // other built-in-AI feature — BYOK (anthropic/openai) skips this
      // entirely, since it's the merchant's own key/cost.
      if (integration.provider === "groq_builtin") {
        const quotaGate = await assertAiQuotaAvailable({ prisma, shop: session.shop });
        if (!quotaGate.ok) return Response.json({ ok: false, error: quotaGate.message }, { status: 403 });
      }

      let product;
      try {
        const data = await shopifyGraphql(session.shop, session.accessToken, PRODUCT_FIELDS_QUERY, { id: gid }, version);
        product = data?.product;
      } catch (err) {
        return Response.json({ ok: false, error: `Could not load product: ${err.message}` }, { status: 502 });
      }
      if (!product) return Response.json({ ok: false, error: "Product not found" }, { status: 404 });

      const result = await generateSeoCopy({
        provider: integration.provider,
        apiKey: integration.apiKey,
        model: integration.model,
        product,
      });
      if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 502 });

      // Only a successful built-in call spends quota — a failed provider
      // call (bad prompt, provider outage) must not cost the shop a credit.
      if (integration.provider === "groq_builtin") {
        await recordAiUsage({ prisma, shop: session.shop });
      }

      return Response.json({
        ok: true,
        productId,
        current: { title: product.title, description: product.descriptionHtml },
        suggested: { title: result.title, description: result.description },
      });
    });
  }

  if (intent === "apply") {
    const title = (formData.get("title") || "").trim();
    const description = (formData.get("description") || "").trim();
    if (!title) return Response.json({ ok: false, error: "Missing title" }, { status: 400 });

    try {
      const data = await shopifyGraphql(session.shop, session.accessToken, PRODUCT_UPDATE_MUTATION, {
        input: { id: gid, title, descriptionHtml: description },
      }, version);
      const errs = data?.productUpdate?.userErrors || [];
      if (errs.length) return Response.json({ ok: false, error: errs.map((e) => e.message).join("; ") }, { status: 400 });
      return Response.json({ ok: true, product: data?.productUpdate?.product });
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 502 });
    }
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
};
