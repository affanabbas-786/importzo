// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Agency-tier eligibility.
//
// Agency unlocks a discounted price ($10 vs Pro's $15) for the SAME
// merchant once they're running Importzo on 3+ stores. Shopify's billing
// API has no concept of "the same merchant across installs" — each store
// is a separate OAuth install with its own session and its own billing
// charge — so this app has to establish that identity itself.
//
// The identity signal used is Admin GraphQL `shop { email }` — the shop's
// contact/notification email. This is the SAME field this app already
// fetches elsewhere (app.transfer.jsx / app.transfer-session.jsx, via
// `{ shop { name email plan { displayName } } ... }`) to identify a
// *source* store's owner during a transfer pairing; this module fetches it
// for the shop Importzo is installed ON. No extra OAuth scope is required —
// this field is unscoped base shop info, same as that existing call.
//
// Deliberately NOT treated as a verified legal identity: a merchant could
// set a generic/shared contact email, which would cause a false-positive
// match across unrelated stores. That's an acceptable, low-probability risk
// for what this gates (a $4/store discount), not something worth a manual
// verification flow — but it's why this signal is never used for anything
// security-sensitive, only the Agency price unlock.
// ═══════════════════════════════════════════════════════════════════

import { AGENCY_MIN_STORES, PLAN_IDS } from "./plans.js";

const SHOP_EMAIL_QUERY = `#graphql
  query ShopOwnerEmail {
    shop { email }
  }`;

/** Fetches the installed shop's own contact email via Admin GraphQL. */
export async function fetchShopOwnerEmail({ shopifyGraphql, shop, token, version }) {
  try {
    const data = await shopifyGraphql(shop, token, SHOP_EMAIL_QUERY, {}, version);
    const email = data?.shop?.email || null;
    return email ? email.trim().toLowerCase() : null;
  } catch (err) {
    console.warn(`[agency-eligibility] could not fetch shop email for ${shop}:`, err?.message);
    return null;
  }
}

/**
 * Refreshes and persists this shop's owner email onto its ShopPlan row.
 * Called opportunistically when the merchant opens Billing/Settings, not on
 * a schedule — if a merchant changes their store's contact email, Agency
 * eligibility catches up next time that page loads. Best-effort: a failed
 * fetch or write leaves the previously-stored email (if any) untouched
 * rather than blocking the page.
 */
export async function refreshShopOwnerEmail({ prisma, shopifyGraphql, shop, token, version }) {
  const email = await fetchShopOwnerEmail({ shopifyGraphql, shop, token, version });
  if (!email) return null;
  try {
    await prisma.shopPlan.update({ where: { shop }, data: { shopOwnerEmail: email } });
  } catch (err) {
    console.warn(`[agency-eligibility] could not persist shop email for ${shop}:`, err?.message);
  }
  return email;
}

/**
 * Counts distinct, currently-installed stores sharing `email` as their shop
 * owner email — including `shop` itself, matching the product wording "3+
 * stores with Importzo installed" as total footprint, not 3 OTHER stores.
 * Uninstalled stores (uninstalledAt set by webhooks.app.uninstalled) don't
 * count: not installed right now, even if they once were.
 */
export async function countMerchantStores({ prisma, email }) {
  if (!email) return 0;
  return prisma.shopPlan.count({
    where: { shopOwnerEmail: email, uninstalledAt: null },
  });
}

/** True once the merchant behind `email` has AGENCY_MIN_STORES+ installs. */
export async function isAgencyEligible({ prisma, email }) {
  if (!email) return false;
  const count = await countMerchantStores({ prisma, email });
  return count >= AGENCY_MIN_STORES;
}

/**
 * Convenience wrapper for route loaders: refreshes this shop's owner email
 * from Shopify, then reports both the live store count and eligibility in
 * one round trip. Never throws — a failed email fetch just yields
 * ineligible (eligibleCount reflects whatever email was already on file, if
 * any) rather than breaking the Billing page.
 */
export async function checkAgencyEligibility({ prisma, shopifyGraphql, shop, token, version }) {
  const email = await refreshShopOwnerEmail({ prisma, shopifyGraphql, shop, token, version })
    .catch(() => null);
  const resolvedEmail = email || (await prisma.shopPlan.findUnique({ where: { shop } }).catch(() => null))?.shopOwnerEmail || null;
  const storeCount = await countMerchantStores({ prisma, email: resolvedEmail });
  return {
    email: resolvedEmail,
    storeCount,
    eligible: storeCount >= AGENCY_MIN_STORES,
    minStores: AGENCY_MIN_STORES,
  };
}

/**
 * Phase 8 — records (or clears) the "on Agency without qualifying for it"
 * flag on this shop's ShopPlan row.
 *
 * Why this exists at all: under Shopify App Pricing, plan selection happens
 * on Shopify's hosted page, which has no idea Agency is supposed to require
 * AGENCY_MIN_STORES+ installs. A single-store merchant can pick Agency and
 * pay $10 instead of Pro's $15. The app used to be able to refuse that at
 * the point of charge; it no longer can.
 *
 * What it deliberately does NOT do is revoke anything. Agency and Pro are
 * feature-identical (both unlimited records, scheduled sync, built-in AI) —
 * Agency is purely a price, so there is no "gate them back to Pro-equivalent"
 * that would have any effect short of cutting a paying merchant down to Free.
 * Doing that on the strength of an email-matching heuristic (see the header
 * of this file: a shared contact address is a known false-positive source,
 * and here it would produce a false NEGATIVE) would break a working store
 * over a $5 pricing discrepancy. So: full access, permanent visible notice
 * on the Billing page, and this durable flag so the discrepancy can be
 * reported on without waiting for the merchant to open a page.
 *
 * Idempotent — an already-flagged shop keeps its ORIGINAL timestamp, so the
 * flag answers "since when", not "as of the last page load".
 */
export async function syncAgencyIneligibilityFlag({ prisma, shop, tier, eligible, now = new Date() }) {
  const shouldFlag = tier === PLAN_IDS.AGENCY && !eligible;

  let row;
  try {
    row = await prisma.shopPlan.findUnique({ where: { shop } });
  } catch (err) {
    console.warn(`[agency-eligibility] could not read ineligibility flag for ${shop}:`, err?.message);
    return null;
  }
  if (!row) return null;

  const current = row.agencyIneligibleSince || null;

  if (shouldFlag) {
    if (current) return current; // already flagged — keep the original date
    try {
      await prisma.shopPlan.update({ where: { shop }, data: { agencyIneligibleSince: now } });
    } catch (err) {
      console.warn(`[agency-eligibility] could not set ineligibility flag for ${shop}:`, err?.message);
      return current;
    }
    console.warn(`[agency-eligibility] ${shop} is on Agency pricing without meeting the ${AGENCY_MIN_STORES}-store requirement — flagged at ${now.toISOString()}`);
    return now;
  }

  if (current) {
    try {
      await prisma.shopPlan.update({ where: { shop }, data: { agencyIneligibleSince: null } });
    } catch (err) {
      console.warn(`[agency-eligibility] could not clear ineligibility flag for ${shop}:`, err?.message);
      return current;
    }
    console.log(`[agency-eligibility] ${shop} no longer flagged — Agency requirement met, or no longer on Agency`);
  }
  return null;
}
