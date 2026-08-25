import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PLANS, PLAN_IDS, BILLING_PLAN_KEY, BILLING_INTERVAL, TRIAL_DAYS } from "./lib/plans.js";
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

// GROQ_API_KEY backs "Built-in AI mapping & enhancement", which billing-ui.js
// lists as an included feature on Pro and Agency — i.e. merchants pay for it.
// It is deliberately a WARNING and not a throw: built-in AI is a secondary
// feature, bring-your-own-key still works without it, and refusing to boot
// would take migrations down over an optional credential.
//
// But it must not be silent either, which is what it was. This key was added
// to .env on 2026-08-13 while the running process had started 2026-08-12, so
// production served a paying feature that threw on every call, for two days,
// with nothing in the boot log to say so — the app looked perfectly healthy.
// A missing credential for a billed feature is a deploy-time fact and belongs
// in the deploy log, next to the other env checks.
if (!process.env.GROQ_API_KEY) { // eslint-disable-line no-undef
  console.warn(
    "[importzo] WARNING: GROQ_API_KEY is not set. Built-in AI (SEO cleanup, alt-text, " +
    "duplicate detection, error diagnosis) is advertised on the Pro and Agency plans and " +
    "will fail for every shop using it. Bring-your-own-key integrations are unaffected. " +
    "If this key was added to .env after the process started, restart PM2 to pick it up.",
  );
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
    `DATABASE_URL points at the LIVE database and production Shopify credentials are in play. ` +
    `Use .env.development (NODE_ENV=development) locally; production's .env stays on the server.`
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

// ═══════════════════════════════════════════════════════════════════
// Phase 10 — the `billing` config, rebuilt for the Manual Billing API.
//
// Derived from plans.js rather than written out by hand. The two have to
// agree — plans.js is what the merchant is SHOWN and this is what they are
// CHARGED — and the only way to guarantee that is to have one of them be a
// function of the other. Writing "15" here as well would create a second
// place for the price to live, which is exactly how a page that advertises
// $15 ends up billing $19.
//
// Four entries, not two: Pro and Agency each need a separate monthly and
// yearly AppSubscription, because interval is a property of the charge, not
// something a single plan can offer both of.
// ═══════════════════════════════════════════════════════════════════
function recurringPlan({ tier, interval }) {
  const plan = PLANS[tier];
  const yearly = interval === BILLING_INTERVAL.YEARLY;
  return {
    lineItems: [
      {
        amount: yearly ? plan.priceYearly : plan.price,
        currencyCode: "USD",
        interval: yearly ? BillingInterval.Annual : BillingInterval.Every30Days,
      },
    ],
    // The advertised trial. Note this grants a trial on EVERY subscription
    // created against this plan, because Shopify keeps no record that a shop
    // has already had one — billing-trial.server.js is what stops that from
    // becoming an unlimited free-usage loop via cancel-and-resubscribe.
    trialDays: TRIAL_DAYS,
  };
}

const BILLING_CONFIG = Object.fromEntries(
  [PLAN_IDS.PRO, PLAN_IDS.AGENCY].flatMap((tier) =>
    [BILLING_INTERVAL.MONTHLY, BILLING_INTERVAL.YEARLY].map((interval) => [
      BILLING_PLAN_KEY[tier][interval],
      recurringPlan({ tier, interval }),
    ]),
  ),
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Phase 10 — the billing config is back, because the app creates its own
  // charges again. See BILLING_CONFIG above for why it is derived rather
  // than literal.
  //
  // IMPORTANT DEPLOY ORDER: while Shopify App Pricing is still enabled in the
  // Partner Dashboard, Shopify REJECTS appSubscriptionCreate from this app
  // ("Managed Pricing Apps cannot use the Billing API (to create charges)").
  // Declaring this config does not by itself change anything or break
  // anything — it only takes effect when billing.request is called, and
  // app.billing.jsx deliberately falls back to the hosted plan page when
  // Shopify refuses. So this is safe to deploy BEFORE the dashboard switch,
  // and starts working the moment the switch is made, with no flag day.
  billing: BILLING_CONFIG,
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
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
