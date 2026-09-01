// Phase 12 — Partner/Agency linking management (merchant-facing CRUD).
//
// POST /api/partner-link intent=generate-code   → B: (re)generate this shop's pairing code
// POST /api/partner-link intent=link-partner    → A: link a partner by domain + its pairing code
// POST /api/partner-link intent=remove-partner  → A: unlink a partner it currently funds
// POST /api/partner-link intent=unlink-self     → B: unlink itself from its current payer
//
// Mirrors api.scheduled-sync.jsx's shape: method guard, rate-limited via
// enforcePolicy, session.shop-scoped ownership checks on every mutation.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { enforcePolicy } from "../lib/rate-limit.server";
import { getUsageStatus } from "../lib/usage.server";
import {
  regeneratePairingCode, linkPartner, unlinkPartner, listLinkedPartners, partnerCount,
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

  if (intent === "generate-code") {
    const { code, expiresAt } = await regeneratePairingCode({ prisma, shop });
    return Response.json({ ok: true, pairingCode: code, pairingCodeExpiresAt: expiresAt });
  }

  if (intent === "link-partner") {
    // Separate, much tighter throttle on top of partnerAdmin above: this is
    // the one operation here that's a guessing target (a 6-digit, 15-minute
    // pairing code). 5 attempts/minute per authenticated shop — see
    // rate-limit.server.js's partnerLinkAttempt policy for why it counts
    // every attempt rather than only failed ones.
    const attemptGate = enforcePolicy({ policyName: "partnerLinkAttempt", shop });
    if (!attemptGate.ok) return attemptGate.response;
    attemptGate.release();

    const partnerDomain = String(formData.get("partnerDomain") || "").trim();
    const pairingCode = String(formData.get("pairingCode") || "").trim();
    const confirmOverwrite = formData.get("confirmOverwrite") === "true";

    const usage = await getUsageStatus({ prisma, shop });
    const result = await linkPartner({
      prisma, payerShop: shop, payerTier: usage.tier, partnerDomain, pairingCode, confirmOverwrite,
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }

  if (intent === "remove-partner") {
    const partnerShop = String(formData.get("partnerShop") || "").trim();
    if (!partnerShop) return Response.json({ ok: false, error: "Missing partnerShop" }, { status: 400 });

    const partner = await prisma.shopPlan.findUnique({ where: { shop: partnerShop } });
    // A partner not currently funded by THIS payer is reported as missing,
    // not forbidden — same as api.scheduled-sync.jsx's ownership check.
    if (!partner || partner.partnerLinkedTo !== shop) {
      return Response.json({ ok: false, error: "Partner store not found" }, { status: 404 });
    }

    const result = await unlinkPartner({ prisma, partnerShop });
    return Response.json({ ok: true, reverted: result.reverted });
  }

  if (intent === "unlink-self") {
    const result = await unlinkPartner({ prisma, partnerShop: shop });
    return Response.json({ ok: true, reverted: result.reverted });
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
