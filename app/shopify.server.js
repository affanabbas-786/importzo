import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { assertEncryptionConfigured } from "./utils/encryption.server";

// Validate required environment variables on startup
const missingVars = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"].filter(
  (v) => !process.env[v] // eslint-disable-line no-undef
);
if (missingVars.length > 0) {
  console.error(`[importzo] FATAL: Missing required env vars: ${missingVars.join(", ")}. App will not function correctly.`);
}

// Guard against a production .env being used for a local dev run.
//
// This started life as the billing safety net: app.billing.jsx used to derive
// isTest from NODE_ENV, so NODE_ENV=production on a dev machine meant a
// "Subscribe" click asked Shopify for a REAL charge. Under Shopify App Pricing
// that specific hazard is gone — Shopify decides test-vs-real from the store
// itself, and this app can't create a charge at all. The guard stays because
// the rest of what it catches is unchanged and just as damaging: a production
// .env on a dev machine points DATABASE_URL at the live database and hands out
// production Shopify credentials. NODE_ENV is pinned to development in
// shopify.web.toml's dev command, but a .env copied from the server is exactly
// the mistake that defeats that, so refuse to boot on the one combination that
// can only mean the files got crossed: production mode on a dev tunnel or
// localhost.
//
// Only an app URL that is present AND parseable is judged: an absent or
// malformed SHOPIFY_APP_URL is the missingVars case above, not this one, and
// must not be turned into a boot failure by this check.
const appUrlHost = (() => {
  if (!process.env.SHOPIFY_APP_URL) return ""; // eslint-disable-line no-undef
  try {
    return new URL(process.env.SHOPIFY_APP_URL).hostname; // eslint-disable-line no-undef
  } catch {
    return "";
  }
})();
const DEV_HOST_PATTERN = /(^localhost$|^127\.|\.trycloudflare\.com$|\.ngrok(-free)?\.(io|app|dev)$|\.loca\.lt$)/;
if (process.env.NODE_ENV === "production" && appUrlHost && DEV_HOST_PATTERN.test(appUrlHost)) { // eslint-disable-line no-undef
  throw new Error(
    `[importzo] FATAL: NODE_ENV=production with a development app URL (${appUrlHost}). ` +
    `This almost certainly means a production .env is being used for local dev — in this state ` +
    `billing would issue real charges. Use .env.development (NODE_ENV=development) locally; ` +
    `production's .env stays on the server.`
  );
}

// ENCRYPTION_KEY is checked differently from the vars above: it THROWS rather
// than logging, so the process refuses to start.
//
// This replaces a console.warn that was the boot-time half of the same
// fail-open bug fixed in encrypt(). A warning scrolls past in a deploy log
// and the app then runs happily, unable to protect the tokens it stores.
// Because encrypt() now throws, a keyless boot would otherwise stay silent
// until the first store connected — turning a config mistake into a runtime
// failure for a user mid-OAuth. Failing here moves it to deploy time, where
// it belongs.
assertEncryptionConfigured();

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Phase 8 — no `billing` config block. The app is registered for Shopify
  // App Pricing (formerly Managed Pricing) in the Partner Dashboard, which
  // owns the plans, the prices, the trial lengths and the charge itself.
  // Shopify rejects appSubscriptionCreate from such apps outright ("Managed
  // Pricing Apps cannot use the Billing API (to create charges)"), so the
  // config that used to declare Pro at $15 and Agency at $10 could only
  // mislead: it described charges this app is no longer permitted to create,
  // in a place a reader would reasonably trust as authoritative. Prices now
  // live in the dashboard, with plans.js holding the display copy that has
  // to be kept in step with it by hand.
  //
  // Removing it does NOT break reading subscription state. This package
  // always passes `unstable_managedPricingSupport: true` down to
  // shopify-api, which is exactly the flag that lets billing.check() run
  // against currentAppInstallation.activeSubscriptions with no billing
  // config present — see app.billing.jsx's reconcile().
  hooks: {
    afterAuth: async ({ session }) => {
      console.log(`[importzo] afterAuth: shop=${session.shop} isOnline=${session.isOnline} scope=${session.scope}`);
      shopify.registerWebhooks({ session });
    },
  },
  // expiringOfflineAccessTokens must match the Shopify Partners Dashboard setting.
  // Token exchange passes this as `expiring:` to Shopify's API; a mismatch causes
  // a non-JWT API error that bubbles up as an empty-body 500 → "Handling response".
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
