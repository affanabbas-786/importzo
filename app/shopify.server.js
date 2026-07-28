import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Validate required environment variables on startup
const missingVars = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"].filter(
  (v) => !process.env[v] // eslint-disable-line no-undef
);
if (missingVars.length > 0) {
  console.error(`[importzo] FATAL: Missing required env vars: ${missingVars.join(", ")}. App will not function correctly.`);
}
if (!process.env.ENCRYPTION_KEY) { // eslint-disable-line no-undef
  console.warn("[importzo] WARNING: ENCRYPTION_KEY is not set. Source store tokens will be stored unencrypted in the database.");
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
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
