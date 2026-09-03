// ═══════════════════════════════════════════════════════════════════
// Phase 12 — Partner/Agency plan linking (flat-priced, consent-free).
//
// A paying store (the payer, "A") funds Pro-equivalent access on companion
// stores it manages ("B") through its OWN Shopify subscription — B never
// touches Shopify Billing. A links a companion directly by entering B's
// myshopify.com domain: no pairing code, no wait, no approval step from B.
// Pricing is flat per tier (Pro covers A + 1 companion, Agency A + 5), so
// linking or unlinking a companion never changes what A is billed — it only
// updates this app's own state.
//
// TRANSPARENCY (replaces consent): the moment B is linked, its ShopPlan row
// is flagged (partnerLinkNoticeDismissedAt = null) so B's dashboard shows a
// persistent banner — "You've been added as a companion by [A]" — until B
// dismisses it or self-unlinks. B can unlink at any time, instantly.
//
// B's own ShopPlan row is authoritative for "who's paying for me"
// (partnerLinkedTo). A's companions are queried live by that field rather
// than stored as a redundant array on A — mirrors countMerchantStores in
// agency-eligibility.server.js. A single field also enforces "a companion
// has at most one payer" by construction.
// ═══════════════════════════════════════════════════════════════════

import { PLAN_IDS, maxPartnersFor, isPartnerLinked, PARTNER_LINKED_STATUS } from "./plans.js";

/** True when this row is currently funded by (or at least pointed at) a payer. */
function isLinked(shopPlanRow) {
  return !!shopPlanRow?.partnerLinkedTo;
}

/** Number of companion stores this payer currently funds. */
export async function partnerCount({ prisma, payerShop }) {
  return prisma.shopPlan.count({ where: { partnerLinkedTo: payerShop } });
}

/** The companion stores this payer currently funds, each flagged if it also holds its own independent paid subscription. */
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
    // companion ALSO holds its own independently active Shopify subscription
    // — billing for it is untouched and unaffected by this link.
    hasIndependentSubscription: !!row.subscriptionId && row.subscriptionStatus === "ACTIVE",
  }));
}

/** Same .myshopify.com normalization app.transfer.jsx's getSourceCreds uses. */
export function normalizeDomain(domain) {
  let url = String(domain || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (url && !url.includes(".")) url = `${url}.myshopify.com`;
  return url;
}

/**
 * Links `partnerDomain` as a companion store funded by `payerShop`.
 *
 * Validates, in order:
 *   1. payer's plan includes companion slots (Pro/Agency, not Free/Basic)
 *   2. companion has Importzo installed (a ShopPlan row, not soft-uninstalled)
 *   3. companion is not already linked to a DIFFERENT payer
 *   4. payer has an available companion slot (Pro: 1, Agency: 5)
 *
 * The cap check and the write happen inside one interactive transaction so
 * two concurrent link attempts against the same payer can't both pass the
 * cap check and both succeed — SQLite serializes writers within a
 * transaction, which is what actually closes the race.
 *
 * Returns one of:
 *   { ok: true, partner }
 *   { ok: false, error }                 — payer ineligible, at cap, companion missing, or already linked elsewhere
 *   { ok: false, warning: true, error }  — companion has its OWN active paid subscription; resubmit with confirmOverwrite to link anyway
 */
export async function linkPartner({ prisma, payerShop, payerTier, partnerDomain, confirmOverwrite = false }) {
  if (maxPartnersFor(payerTier) === 0) {
    return { ok: false, error: "Your current plan doesn't include companion stores — upgrade to Pro or Agency first." };
  }

  const domain = normalizeDomain(partnerDomain);
  if (!domain) {
    return { ok: false, error: "Enter the companion store's myshopify.com domain." };
  }
  if (domain === payerShop) {
    return { ok: false, error: "A store can't link itself as a companion." };
  }

  return prisma.$transaction(async (tx) => {
    const partner = await tx.shopPlan.findUnique({ where: { shop: domain } });
    if (!partner || partner.uninstalledAt) {
      return { ok: false, error: "No store with Importzo installed was found at that domain. Check the spelling, and make sure they've installed Importzo first." };
    }
    if (partner.partnerLinkedTo === payerShop) {
      return { ok: false, error: "That store is already one of your companions." };
    }
    if (partner.partnerLinkedTo) {
      return { ok: false, error: "That store is already linked to another account." };
    }

    // Cap check last: an already-linked companion counts toward the cap, so
    // checking it before the idempotent re-link case above would mask it.
    const linkedCount = await tx.shopPlan.count({ where: { partnerLinkedTo: payerShop } });
    const max = maxPartnersFor(payerTier);
    if (linkedCount >= max) {
      return { ok: false, error: `Your plan allows up to ${max} companion store${max === 1 ? "" : "s"} — you're already at that limit.` };
    }

    const hasIndependentSubscription = !!partner.subscriptionId && partner.subscriptionStatus === "ACTIVE";
    if (hasIndependentSubscription && !confirmOverwrite) {
      return {
        ok: false,
        warning: true,
        error: "That store already has its own active Pro subscription — linking won't change its billing or downgrade it.",
      };
    }

    // Reset the companion notice so B's dashboard banner shows for this link.
    const data = {
      partnerLinkedTo: payerShop,
      partnerLinkNoticeDismissedAt: null,
    };
    // Only overwrite tier/subscription fields for a companion with no
    // independent billing of its own — an independently-paying companion
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
 * Reverts `partnerShop` from a companion-linked (or independently-paying but
 * still linked) state back to standalone. Ownership (only B itself, or its
 * current payer, may call this) is the CALLER's responsibility — this
 * function trusts partnerShop unconditionally, matching how
 * cascadeRevokePartnerLinks below also uses it for every linked row at
 * once.
 *
 * A plain companion (no billing of its own) reverts to Free — the grant it
 * held had no Shopify subscription behind it. A companion that ALSO holds
 * its own independent paid subscription just has the link cleared; its own
 * plan is untouched.
 */
export async function unlinkPartner({ prisma, partnerShop }) {
  const row = await prisma.shopPlan.findUnique({ where: { shop: partnerShop } });
  if (!row || !isLinked(row)) return { ok: true, reverted: false };

  const data = { partnerLinkedTo: null, partnerLinkNoticeDismissedAt: null };
  if (isPartnerLinked(row.subscriptionStatus)) {
    data.tier = PLAN_IDS.FREE;
    data.subscriptionStatus = null;
    data.subscriptionId = null;
  }
  await prisma.shopPlan.update({ where: { shop: partnerShop }, data });
  return { ok: true, reverted: true };
}

/**
 * Marks this companion's "you were added" banner as acknowledged. Idempotent
 * and a no-op for a store that isn't linked.
 */
export async function dismissPartnerLinkNotice({ prisma, shop, now = new Date() }) {
  const row = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!row || !isLinked(row)) return { ok: true, dismissed: false };
  await prisma.shopPlan.update({
    where: { shop },
    data: { partnerLinkNoticeDismissedAt: now },
  });
  return { ok: true, dismissed: true };
}

/**
 * Whether B's dashboard should show the "you've been added as a companion"
 * banner: linked, funded by the payer's grant, and not yet acknowledged.
 * Takes the fields it needs so it works from a ShopPlan row or a usage
 * status object alike.
 */
export function shouldShowPartnerLinkNotice({ partnerLinkedTo, subscriptionStatus, partnerLinkNoticeDismissedAt }) {
  return (
    !!partnerLinkedTo &&
    isPartnerLinked(subscriptionStatus) &&
    !partnerLinkNoticeDismissedAt
  );
}

/**
 * Reverts EVERY companion store `payerShop` funds — called when the payer's
 * own subscription genuinely lapses or the payer uninstalls (see
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
