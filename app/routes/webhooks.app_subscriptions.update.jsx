// Phase 7 — billing audit: react to Shopify's app_subscriptions/update
// webhook, fired whenever an AppSubscription's status changes (activated,
// cancelled, expired, frozen, declined) — including changes that happen
// OUTSIDE this app entirely (the merchant cancelling from Shopify's own
// admin billing settings, a declined payment, an auto-expired trial).
//
// Without this, ShopPlan.tier only re-syncs the next time the merchant
// happens to open app.billing.jsx (its loader calls billing.check() on
// every load) — a shop that cancels and never revisits that page would
// keep every gated feature (scheduled sync, unlimited records, built-in
// AI) working indefinitely on a lapsed subscription. This webhook closes
// that gap by updating ShopPlan.tier the moment Shopify reports the change,
// not on next-login.
//
// Payload shape is Shopify's documented one for this topic:
//   { app_subscription: { admin_graphql_api_id, name, status,
//                          admin_graphql_api_shop_id, created_at, updated_at } }
// `shop` used to key the ShopPlan row comes from the HMAC-verified webhook
// context (authenticate.webhook), never from the payload — same rule every
// other webhook handler in this app follows.

// Phase 8 note — under Shopify App Pricing this topic is no longer the
// documented notification channel (Shopify passes plan details as URL
// parameters on the post-approval redirect instead, and says to query the
// Partner API for changes that happen off-redirect). The handler is kept
// registered rather than deleted: it costs nothing when Shopify doesn't
// send the topic, and if it does still fire it closes exactly the gap it
// was written for. app.billing.jsx's reconcile() remains the reliable path.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLAN_IDS, tierFromSubscriptionName, isComplimentary } from "../lib/plans.js";
import { getUsageStatus, setShopTier } from "../lib/usage.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const subscription = payload?.app_subscription;
  if (!shop || !subscription) return new Response();

  const { name, status, admin_graphql_api_id: subscriptionId } = subscription;
  const isActive = status === "ACTIVE";

  try {
    if (isActive) {
      // A subscription just activated — always current news, apply forward
      // unconditionally. Covers a fresh subscribe AND an upgrade/downgrade
      // between paid tiers (Shopify's default replacementBehavior cancels
      // the old subscription and activates the new one on approval).
      // Keyword match, not an exact plan-name lookup — see
      // tierFromSubscriptionName: App Pricing plan names come from the
      // Partner Dashboard and may differ per language and per billing
      // interval, and an unrecognised name here would downgrade a merchant
      // who just successfully paid.
      const tier = tierFromSubscriptionName(name) || PLAN_IDS.FREE;
      await setShopTier({ prisma, shop, tier, subscriptionId: subscriptionId || null, subscriptionStatus: status });
      console.log(`[webhooks/app_subscriptions/update] ${shop}: tier -> ${tier} (subscription "${name}" activated)`);
    } else {
      // A subscription became inactive (cancelled/declined/expired/frozen).
      // Only downgrade to Free if this notification is about the
      // subscription CURRENTLY on file. Switching plans (e.g. Pro ->
      // Agency) fires two webhooks — the new plan's ACTIVE and the old
      // plan's CANCELLED — in no guaranteed order. If the old plan's
      // CANCELLED arrives AFTER the new plan's ACTIVE already updated
      // ShopPlan, applying it blindly would wrongly reset a merchant who
      // just upgraded back to Free. A subscriptionId mismatch means this
      // event is stale — about a subscription that's already been
      // superseded — so it's ignored rather than applied.
      const current = await getUsageStatus({ prisma, shop });

      // A complimentary grant carries no subscriptionId, which would otherwise
      // satisfy the `!current.subscriptionId` test below and let any unrelated
      // inactive-subscription event revoke it. The grant is not backed by the
      // subscription this event describes, so the event says nothing about it.
      if (isComplimentary(current.subscriptionStatus)) {
        console.log(`[webhooks/app_subscriptions/update] ${shop}: ignored ${status} — shop holds a complimentary ${current.tier} grant`);
      } else if (!current.subscriptionId || current.subscriptionId === subscriptionId) {
        await setShopTier({ prisma, shop, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: status });
        console.log(`[webhooks/app_subscriptions/update] ${shop}: tier -> free (subscription "${name}" status=${status})`);
      } else {
        console.log(`[webhooks/app_subscriptions/update] ${shop}: ignored stale ${status} for superseded subscription ${subscriptionId}`);
      }
    }
  } catch (err) {
    // Never let a webhook processing failure surface as a delivery error
    // Shopify would retry indefinitely — log loudly instead. Worst case,
    // the next app.billing.jsx page load reconciles it via billing.check().
    console.error(`[webhooks/app_subscriptions/update] ${shop}: failed to update ShopPlan:`, err?.message);
  }

  return new Response();
};
