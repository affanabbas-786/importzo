// Phase 12 — Partner/Agency linking management (merchant-facing CRUD).
//
// POST /api/partner-link intent=link-partner       → A: link a companion by its myshopify domain
// POST /api/partner-link intent=remove-partner     → A: unlink a companion it currently funds
// POST /api/partner-link intent=unlink-self        → B: unlink itself from its current payer
// POST /api/partner-link intent=dismiss-link-notice → B: acknowledge the "you were added" banner
//
// Linking is direct and consent-free (see partner-linking.server.js): there
// is no pairing code, so there is no guessing target and no bespoke
// per-attempt throttle — the general partnerAdmin policy covers it.
//
// Mirrors api.scheduled-sync.jsx's shape: method guard, rate-limited via
// enforcePolicy, session.shop-scoped ownership checks on every mutation.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { enforcePolicy } from "../lib/rate-limit.server";
import { getUsageStatus } from "../lib/usage.server";
import {
  linkPartner, unlinkPartner, dismissPartnerLinkNotice, listLinkedPartners, partnerCount,
} from "../lib/partner-linking.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const gate = enforcePolicy({ policyName: "partnerAdmin", shop });
  if (!gate.ok) return gate.response;
  gate.release();

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "link-partner") {
    const partnerDomain = String(formData.get("partnerDomain") || "").trim();
    const confirmOverwrite = formData.get("confirmOverwrite") === "true";

    const usage = await getUsageStatus({ prisma, shop });
    const result = await linkPartner({
      prisma, payerShop: shop, payerTier: usage.tier, partnerDomain, confirmOverwrite,
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  if (intent === "remove-partner") {
    const partnerShop = String(formData.get("partnerShop") || "").trim();
    if (!partnerShop) return Response.json({ ok: false, error: "Missing partnerShop" }, { status: 400 });

    const partner = await prisma.shopPlan.findUnique({ where: { shop: partnerShop } });
    // A companion not currently funded by THIS payer is reported as missing,
    // not forbidden — same as api.scheduled-sync.jsx's ownership check.
    if (!partner || partner.partnerLinkedTo !== shop) {
      return Response.json({ ok: false, error: "Companion store not found" }, { status: 404 });
    }

    const result = await unlinkPartner({ prisma, partnerShop });
    return Response.json({ ok: true, reverted: result.reverted });
  }

  if (intent === "unlink-self") {
    const result = await unlinkPartner({ prisma, partnerShop: shop });
    return Response.json({ ok: true, reverted: result.reverted });
  }

  if (intent === "dismiss-link-notice") {
    const result = await dismissPartnerLinkNotice({ prisma, shop });
    return Response.json({ ok: true, dismissed: result.dismissed });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
};

// Read-only convenience for the Partner Stores page's fetcher-driven
// refreshes (avoids a full navigation reload after every mutation).
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [partners, count] = await Promise.all([
    listLinkedPartners({ prisma, payerShop: shop }),
    partnerCount({ prisma, payerShop: shop }),
  ]);
  return Response.json({ ok: true, partners, count });
};
