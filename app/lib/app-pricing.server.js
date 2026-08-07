// ═══════════════════════════════════════════════════════════════════
// Phase 8 — Shopify App Pricing (formerly "Managed Pricing").
//
// The app is now registered for Shopify App Pricing in the Partner
// Dashboard, which means Shopify owns plan selection AND charge creation.
// appSubscriptionCreate is rejected outright for such apps ("Managed Pricing
// Apps cannot use the Billing API (to create charges)"), so app.billing.jsx
// no longer calls billing.request — it sends the merchant to Shopify's own
// hosted plan-selection page instead.
//
// READING subscription state is unaffected: billing.check() is a query
// against currentAppInstallation.activeSubscriptions and returns App
// Pricing subscriptions the same as Billing API ones. Only the write path
// is gone. (shopify-app-react-router always passes
// `unstable_managedPricingSupport: true` down to shopify-api, which is what
// lets billing.check() work with no `billing` config block at all — see
// shopify.server.js.)
// ═══════════════════════════════════════════════════════════════════

const APP_HANDLE_QUERY = `#graphql
  query AppHandle {
    currentAppInstallation { app { handle } }
  }`;

// The handle Shopify uses in the plan-selection URL is the app's public
// handle — the same one in its App Store listing URL, which this app's own
// marketing page already links as https://apps.shopify.com/importzo.
//
// It is NOT in shopify.app.toml (this app predates the CLI writing a
// `handle` field, and its local manifest carries an empty one), so it can't
// be read from config. resolveAppHandle below asks Shopify for the live
// value and only falls back to this constant when that fails — a wrong
// handle produces a 404 inside the Shopify admin, which is exactly the kind
// of thing that shouldn't rest on a hard-coded guess.
export const DEFAULT_APP_HANDLE = "importzo";

// Resolved once per process. The handle is a property of the app, not of the
// shop, so the first successful lookup is good for every shop afterwards.
let cachedAppHandle = null;

/** Test seam: drops the memoised handle so each test resolves from scratch. */
export function resetAppHandleCache() {
  cachedAppHandle = null;
}

/** "cool-shop.myshopify.com" -> "cool-shop", which is what admin URLs use. */
export function storeHandleFromShop(shop) {
  return String(shop || "").replace(/\.myshopify\.com$/i, "");
}

/**
 * Shopify's hosted plan-selection page for this app, inside this merchant's
 * admin. Pure — takes the already-resolved handle rather than fetching it,
 * so the URL shape is testable without a Shopify client.
 */
export function planSelectionUrl({ shop, appHandle = DEFAULT_APP_HANDLE }) {
  const store = storeHandleFromShop(shop);
  return `https://admin.shopify.com/store/${store}/charges/${appHandle}/pricing_plans`;
}

/**
 * The app's public handle, in order of preference:
 *   1. SHOPIFY_APP_HANDLE — an explicit override, for when the dashboard
 *      handle and the App Store listing ever diverge.
 *   2. Admin GraphQL `currentAppInstallation { app { handle } }` — the live,
 *      authoritative value. Needs no extra access scope: an app querying its
 *      own installation is always permitted.
 *   3. DEFAULT_APP_HANDLE.
 *
 * Never throws — a failed lookup degrades to the fallback rather than
 * breaking the Billing page, and is not cached, so the next page load
 * retries.
 */
export async function resolveAppHandle({ shopifyGraphql, shop, token, version }) {
  const override = process.env.SHOPIFY_APP_HANDLE; // eslint-disable-line no-undef
  if (override) return override.trim();

  if (cachedAppHandle) return cachedAppHandle;

  try {
    const data = await shopifyGraphql(shop, token, APP_HANDLE_QUERY, {}, version);
    const handle = data?.currentAppInstallation?.app?.handle;
    if (handle && typeof handle === "string") {
      cachedAppHandle = handle.trim();
      return cachedAppHandle;
    }
  } catch (err) {
    console.warn(`[app-pricing] could not resolve app handle for ${shop}:`, err?.message);
  }

  return DEFAULT_APP_HANDLE;
}
