import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { assertEncryptionConfigured } from "./utils/encryption.server";
import { SHOPIFY_PLAN_NAME } from "./lib/plans.js";

// Validate required environment variables on startup
const missingVars = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"].filter(
  (v) => !process.env[v] // eslint-disable-line no-undef
);
if (missingVars.length > 0) {
  console.error(`[importzo] FATAL: Missing required env vars: ${missingVars.join(", ")}. App will not function correctly.`);
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
  // Phase 5 — Billing. Standard Shopify Billing API (AppSubscription via
  // billing.request/.check/.require — see app.billing.jsx), not the
  // dashboard-configured "Shopify Managed Pricing" plans: Agency's
  // eligibility depends on cross-store logic (agency-eligibility.server.js)
  // that dashboard-configured pricing can't express, so plan selection has
  // to stay code-driven.
  //
  // Free has no entry here — Shopify doesn't support a $0 recurring charge,
  // so Free is simply "no active subscription" (see plans.js, usage.server.js).
  // Agency is priced at $10 as its own plan rather than a discount override
  // of Pro: it's a distinct named charge a shop either does or doesn't
  // qualify for, not a coupon applied to Pro's charge. Every line item is
  // explicitly USD — this app has no per-market/currency pricing.
  billing: {
    [SHOPIFY_PLAN_NAME.pro]: {
      lineItems: [{ amount: 15, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
    [SHOPIFY_PLAN_NAME.agency]: {
      lineItems: [{ amount: 10, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
  },
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
