// Phase 2 — Dry-run / preview API.
//
// POST /api/transfer-preview  → "if I run this transfer, what changes?"
//
// Read-only by construction: it fetches from the source and the destination
// and writes nothing to either. Source credentials resolve the same way the
// real transfer resolves them (TransferSession → form → saved SourceStore),
// so a preview can't accidentally diff a different pair of stores than the
// transfer it's previewing.

import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { decrypt } from "../utils/encryption.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { getSavedSourceStore } from "../lib/safe-db";
import { computeTransferDiff } from "../lib/transfer-diff.server";

// Preview only needs matching + comparison fields — not descriptions,
// variants or media.
const SOURCE_PREVIEW_QUERY = `#graphql
  query PreviewSourceProducts($after: String) {
    products(first: 250, after: $after) {
      edges { cursor node { id handle title vendor productType status publishedAt } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const MAX_SOURCE_PREVIEW_PRODUCTS = 50000;

async function fetchSourceProductsForPreview(shop, token, version) {
  const products = [];
  let after = null;
  let hasNextPage = true;
  let truncated = false;

  while (hasNextPage) {
    const data = await shopifyGraphql(shop, token, SOURCE_PREVIEW_QUERY, { after }, version);
    const connection = data?.products;
    for (const edge of connection?.edges || []) {
      if (products.length >= MAX_SOURCE_PREVIEW_PRODUCTS) { truncated = true; break; }
      products.push(edge.node);
    }
    if (truncated) break;
    hasNextPage = !!connection?.pageInfo?.hasNextPage;
    after = connection?.pageInfo?.endCursor || null;
    if (!after) break;
  }
  return { products, truncated };
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const version = apiVersion || "2025-10";
  const conflictMode = (formData.get("conflictMode") || "skip").trim();

  // Resolve source credentials exactly as the transfer does.
  let sourceShop = "";
  let sourceToken = "";

  const sessionId = (formData.get("sessionId") || "").trim();
  if (sessionId) {
    try {
      const ts = await prisma.transferSession.findUnique({ where: { id: sessionId } });
      if (ts && ts.status !== "done") {
        sourceShop = ts.sourceShop;
        sourceToken = decrypt(ts.sourceToken);
      }
    } catch (err) {
      console.warn("[api/transfer-preview] session lookup failed:", err?.message);
    }
  }

  if (!sourceShop || !sourceToken) {
    sourceShop = (formData.get("sourceShop") || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    sourceToken = (formData.get("sourceToken") || "").trim();
  }

  if (!sourceShop || !sourceToken) {
    const saved = await getSavedSourceStore(session.shop);
    if (saved) { sourceShop = saved.sourceUrl; sourceToken = saved.token; }
  }

  if (!sourceShop || !sourceToken) {
    return Response.json({ ok: false, error: "Missing source store credentials" }, { status: 400 });
  }
  if (!sourceShop.includes(".")) sourceShop = `${sourceShop}.myshopify.com`;

  try {
    const { products, truncated: sourceTruncated } = await fetchSourceProductsForPreview(sourceShop, sourceToken, version);

    const diff = await computeTransferDiff({
      shopifyGraphql,
      destShop: session.shop,
      destToken: session.accessToken,
      version,
      sourceProducts: products,
      conflictMode,
    });

    return Response.json({
      ok: true,
      sourceShop,
      destShop: session.shop,
      conflictMode,
      sourceProductCount: products.length,
      sourceTruncated,
      ...diff,
    });
  } catch (err) {
    console.error("[api/transfer-preview] failed:", err?.message);
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 502 });
  }
};
