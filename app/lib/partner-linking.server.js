// ═══════════════════════════════════════════════════════════════════
// Phase 12 — Partner/Agency plan linking.
//
// A paying store (the payer, "A") funds Pro-equivalent access on other
// stores it manages ("partners", "B") through its OWN Shopify subscription —
// B never touches Shopify Billing. B generates a short-lived pairing code;
// A enters B's myshopify domain + that code to link it.
//
// B's own ShopPlan row is authoritative for "who's paying for me"
// (partnerLinkedTo). A's linked partners are queried live by that field
// rather than stored as a redundant array on A — mirrors
// countMerchantStores in agency-eligibility.server.js. A single field also
// trivially enforces "a partner has at most one payer" by construction.
//
// Shopify's Billing API has no mutation to silently change an existing
// recurring subscription's price, so linking/unlinking a partner only ever
// updates this app's own state here — features and slot counts change
// instantly and correctly. Recalculating what A is actually BILLED is a
// separate, explicit step the merchant takes on app.partners.jsx (compares
// the live-correct price against what Shopify reports and offers an
// "Update subscription" approval, same flow as any other plan change).
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";
import { PLAN_IDS, maxPartnersFor, isPartnerLinked, PARTNER_LINKED_STATUS } from "./plans.js";

const PAIRING_CODE_DIGITS = 6;
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * 6-digit numeric pairing code, drawn via crypto.randomBytes with rejection
 * sampling to avoid modulo bias — same anti-bias technique as
 * app.transfer-session.jsx's generateSessionCode, digits only here (the
 * product spec calls for a "6-digit code", unlike TransferSession's wider
 * alnum alphabet).
 */
export function generatePairingCode() {
  const bytes = crypto.randomBytes(32);
  let code = "";
  for (let i = 0; i < bytes.length && code.length < PAIRING_CODE_DIGITS; i++) {
    // 256 % 10 !== 0, so bytes >= 250 would bias toward low digits — reject them.
    if (bytes[i] < 250) code += String(bytes[i] % 10);
  }
  while (code.length < PAIRING_CODE_DIGITS) {
    code += String(crypto.randomInt(0, 10));
  }
  return code;
}

/**
 * (Re)generates this shop's pairing code, overwriting — and so immediately
 * invalidating — any code already outstanding. Retries on the astronomically
 * rare unique-constraint collision (pairingCode is unique across every shop)
 * rather than surfacing it as a 500.
 */
export async function regeneratePairingCode({ prisma, shop, now = new Date() }) {
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePairingCode();
    try {
      await prisma.shopPlan.update({
        where: { shop },
        data: { pairingCode: code, pairingCodeExpiresAt: expiresAt },
      });
      return { code, expiresAt };
    } catch (err) {
      if (err?.code !== "P2002") throw err;
      // Unique-constraint collision on pairingCode — try another code.
    }
  }
  throw new Error("Could not generate a unique pairing code — please try again.");
}

/** Distinct stores currently paying for `partnerShop`'s Pro access — 0 or 1. */
function isLinked(shopPlanRow) {
  return !!shopPlanRow?.partnerLinkedTo;
}

/** Number of stores this payer currently funds. */
export async function partnerCount({ prisma, payerShop }) {
  return prisma.shopPlan.count({ where: { partnerLinkedTo: payerShop } });
}

/** The stores this payer currently funds, each flagged if it also holds its own independent paid subscription. */
export async function listLinkedPartners({ prisma, payerShop }) {
  const rows = await prisma.shopPlan.findMany({
    where: { partnerLinkedTo: payerShop },
    select: { shop: true, tier: true, subscriptionId: true, subscriptionStatus: true },
    orderBy: { shop: "asc" },
  });
  return rows.map((row) => ({
    shop: row.shop,
    tier: row.tier,
    // Set up during linking (see linkPartner below): true only when this
    // partner ALSO holds its own independently active Shopify subscription
    // — billing for it is untouched and unaffected by this link.
    hasIndependentSubscription: !!row.subscriptionId && row.subscriptionStatus === "ACTIVE",
  }));
}

/** Same .myshopify.com normalization app.transfer.jsx's getSourceCreds uses. */
function normalizeDomain(domain) {
  let url = String(domain || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (url && !url.includes(".")) url = `${url}.myshopify.com`;
  return url;
}

const INVALID_CODE_MESSAGE = "Invalid or expired pairing code.";

/**
 * Links `partnerDomain` as a partner store funded by `payerShop`.
 *
 * The cap check and the write happen inside one interactive transaction so
 * two concurrent link attempts against the same payer can't both pass the
 * cap check and both succeed — SQLite serializes writers within a
 * transaction, which is what actually closes the race.
 *
 * Returns one of:
 *   { ok: true, partner }
 *   { ok: false, error }                 — payer not eligible, at cap, bad/expired code, or already linked elsewhere
 *   { ok: false, warning: true, error }  — partner already has its OWN active paid subscription; resubmit with confirmOverwrite to proceed anyway
 */
export async function linkPartner({ prisma, payerShop, payerTier, partnerDomain, pairingCode, confirmOverwrite = false, now = new Date() }) {
  if (maxPartnersFor(payerTier) === 0) {
    return { ok: false, error: "Your current plan doesn't include partner stores — upgrade to Pro or Agency first." };
  }

  const domain = normalizeDomain(partnerDomain);
  const code = String(pairingCode || "").trim();
  if (!domain || !code) {
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }
  if (domain === payerShop) {
    return { ok: false, error: "A store can't link itself as a partner." };
  }

  return prisma.$transaction(async (tx) => {
    const linkedCount = await tx.shopPlan.count({ where: { partnerLinkedTo: payerShop } });
    const max = maxPartnersFor(payerTier);
    if (linkedCount >= max) {
      return { ok: false, error: `Your plan allows up to ${max} partner store${max === 1 ? "" : "s"} — you're already at that limit.` };
    }

    const partner = await tx.shopPlan.findUnique({ where: { shop: domain } });
    if (!partner || partner.pairingCode !== code || !partner.pairingCodeExpiresAt || new Date(partner.pairingCodeExpiresAt) < now) {
      return { ok: false, error: INVALID_CODE_MESSAGE };
    }
    if (partner.partnerLinkedTo && partner.partnerLinkedTo !== payerShop) {
      return { ok: false, error: "This store is already linked to another partner account." };
    }

    const hasIndependentSubscription = !!partner.subscriptionId && partner.subscriptionStatus === "ACTIVE";
    if (hasIndependentSubscription && !confirmOverwrite) {
      return {
        ok: false,
        warning: true,
        error: "This store already has an active Pro subscription — linking will not change billing.",
      };
    }

    const data = {
      partnerLinkedTo: payerShop,
      pairingCode: null,
      pairingCodeExpiresAt: null,
    };
    // Only overwrite tier/subscription fields for a partner with no
    // independent billing of its own — an independently-paying partner
    // keeps being billed directly by Shopify, unaffected by this link.
    if (!hasIndependentSubscription) {
      data.tier = PLAN_IDS.PRO;
      data.subscriptionStatus = PARTNER_LINKED_STATUS;
      data.subscriptionId = null;
    }

    const updated = await tx.shopPlan.update({ where: { shop: domain }, data });
    return { ok: true, partner: { shop: updated.shop, tier: updated.tier, hasIndependentSubscription } };
  });
}

/**
 * Reverts `partnerShop` from a partner-linked (or independently-paying but
 * still linked) state back to standalone. Ownership (only B itself, or its
 * current payer, may call this) is the CALLER's responsibility — this
 * function trusts partnerShop unconditionally, matching how
 * cascadeRevokePartnerLinks below also uses it for every linked row at
 * once.
 *
 * A plain partner-linked shop (no billing of its own) reverts to Free — the
 * grant it held had no Shopify subscription behind it. A shop that ALSO
 * holds its own independent paid subscription just has the link cleared;
 * its own plan is untouched.
 */
export async function unlinkPartner({ prisma, partnerShop }) {
  const row = await prisma.shopPlan.findUnique({ where: { shop: partnerShop } });
  if (!row || !isLinked(row)) return { ok: true, reverted: false };

  const data = { partnerLinkedTo: null };
  if (isPartnerLinked(row.subscriptionStatus)) {
    data.tier = PLAN_IDS.FREE;
    data.subscriptionStatus = null;
    data.subscriptionId = null;
  }
  await prisma.shopPlan.update({ where: { shop: partnerShop }, data });
  return { ok: true, reverted: true };
}

/**
 * Reverts EVERY store `payerShop` funds — called when the payer's own
 * subscription genuinely lapses or the payer uninstalls (see
 * webhooks.app_subscriptions.update.jsx and webhooks.app.uninstalled.jsx).
 *
 * Best-effort per row, mirroring deleteShopData/webhooks.app.uninstalled's
 * style: one bad row must not block reverting the rest.
 */
export async function cascadeRevokePartnerLinks({ prisma, payerShop }) {
  const partners = await prisma.shopPlan.findMany({
    where: { partnerLinkedTo: payerShop },
    select: { shop: true },
  });
  let reverted = 0;
  const errors = [];
  for (const { shop } of partners) {
    try {
      const result = await unlinkPartner({ prisma, partnerShop: shop });
      if (result.reverted) reverted += 1;
    } catch (err) {
      errors.push({ shop, error: err?.message || String(err) });
    }
  }
  return { total: partners.length, reverted, errors };
}

/**
 * The price A's Agency subscription SHOULD be at the given live partner
 * count — thin re-export of plans.js's formula so callers only need this
 * module. Pro is never variable (1 slot included, flat price) so this is
 * Agency-only; callers should not call it for other tiers.
 */
export { agencyPartnerPrice as expectedAgencyPrice } from "./plans.js";
