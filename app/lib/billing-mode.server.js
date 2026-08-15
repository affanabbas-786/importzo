// ═══════════════════════════════════════════════════════════════════
// Phase 10 — two questions the charge path has to answer before it can
// safely create an AppSubscription.
//
//   1. Is this a real charge or a test one?
//   2. Did Shopify refuse because App Pricing is still switched on?
//
// Both are here rather than in the route because both are decisions with a
// money consequence, and both need to be testable without a Shopify client.
// ═══════════════════════════════════════════════════════════════════

const SHOP_PLAN_QUERY = `#graphql
  query ImportzoShopBillingPlan {
    shop {
      plan {
        partnerDevelopment
        shopifyPlus
        publicDisplayName
      }
    }
  }`;

/**
 * Whether charges for this shop must be created as TEST charges.
 *
 * Deliberately NOT derived from NODE_ENV. That was the old isTestCharge()
 * before the App Pricing migration, and it is the wrong input twice over: a
 * production .env on a developer's machine made real charges, and — far more
 * expensive — any deploy where NODE_ENV failed to reach the process (a bare
 * `node build/server/index.js`, a `pm2 restart` without --update-env) would
 * silently create TEST charges against real merchants. A test charge looks
 * completely normal to the merchant: they approve it, they get the plan, and
 * no money is ever collected. That failure is invisible until a payout report.
 *
 * `partnerDevelopment` is the authoritative answer from Shopify itself about
 * the shop being charged, so it cannot be knocked out of step by how the
 * process was started.
 *
 * Fails CLOSED (returns false -> a real charge) if the query fails. Shopify
 * independently refuses to bill development stores, so a real charge against
 * a dev store is declined rather than mischarged; a test charge against a real
 * store is silent free service. Only one of those two errors is recoverable.
 */
export async function isTestCharge({ shopifyGraphql, shop, token, version }) {
  try {
    const data = await shopifyGraphql(shop, token, SHOP_PLAN_QUERY, {}, version);
    const plan = data?.shop?.plan;
    if (typeof plan?.partnerDevelopment !== "boolean") {
      console.warn(`[billing-mode] no partnerDevelopment flag for ${shop} — treating as a REAL charge`);
      return false;
    }
    if (plan.partnerDevelopment) {
      console.log(`[billing-mode] ${shop} is a development store — creating a TEST charge`);
    }
    return plan.partnerDevelopment;
  } catch (err) {
    console.warn(`[billing-mode] could not read shop plan for ${shop} — treating as a REAL charge:`, err?.message);
    return false;
  }
}

// Shopify's refusal when an app registered for Shopify App Pricing (formerly
// Managed Pricing) calls appSubscriptionCreate. Matched on the distinctive
// part of the message rather than the whole string so a wording tweak or a
// localized variant does not turn a recognised, handled condition into an
// unhandled 500 on the merchant's Billing page.
const MANAGED_PRICING_REFUSAL = /managed pricing|app pricing/i;
const BILLING_API_REFUSAL = /cannot use the billing api|not permitted to create charges/i;

/**
 * Whether a thrown error is Shopify saying "this app is on App Pricing, so it
 * may not create charges".
 *
 * This is the one error the Billing page must not surface as a failure: it
 * means the code has been deployed before the Partner Dashboard has been
 * switched over, which is the deliberate deploy order. The caller falls back
 * to the hosted plan page — the exact behaviour merchants had before — so the
 * window between deploying and switching is uneventful rather than broken.
 *
 * Both patterns must be present, not either: "app pricing" alone is loose
 * enough to appear in unrelated messages, while the pair only co-occurs in
 * this specific refusal.
 */
export function isManagedPricingRejection(error) {
  const text = describeBillingError(error);
  if (!text) return false;
  return MANAGED_PRICING_REFUSAL.test(text) && BILLING_API_REFUSAL.test(text);
}

/**
 * Everything a BillingError actually knows, as one searchable string.
 *
 * `error.message` alone is useless here and that cost a live debugging cycle:
 * @shopify/shopify-api throws every appSubscriptionCreate failure as the same
 * generic "Error while billing the store" and puts the real reason — Shopify's
 * userErrors or GraphQL errors array — on a separate `errorData` property.
 * Matching or logging the message alone therefore reports nothing useful and,
 * worse, makes a recognised-and-handled condition look like an unknown crash.
 *
 * Used for BOTH the rejection test above and the error log, so the two can
 * never disagree about what Shopify said.
 */
export function describeBillingError(error) {
  const parts = [String(error?.message || "")];

  const data = error?.errorData;
  if (data) {
    try {
      parts.push(typeof data === "string" ? data : JSON.stringify(data));
    } catch {
      // A non-serializable errorData is still worth naming rather than
      // dropping the whole diagnostic on the floor.
      parts.push(String(data));
    }
  }

  return parts.filter(Boolean).join(" | ");
}
