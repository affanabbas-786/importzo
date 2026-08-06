import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Every other test suite mocks app/shopify.server. This one imports the REAL
// module, because the thing under test is its boot-time side effects — so the
// Shopify SDK and Prisma are stubbed instead, to keep booting inert.
vi.mock("@shopify/shopify-app-react-router/adapters/node", () => ({}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  ApiVersion: { October25: "2025-10" },
  AppDistribution: { AppStore: "app_store" },
  BillingInterval: { OneTime: "ONE_TIME", Every30Days: "EVERY_30_DAYS", Annual: "ANNUAL", Usage: "USAGE" },
  shopifyApp: () => ({
    registerWebhooks: vi.fn(),
    addDocumentResponseHeaders: vi.fn(),
    authenticate: {},
    unauthenticated: {},
    login: vi.fn(),
    sessionStorage: {},
  }),
}));
vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({
  PrismaSessionStorage: class PrismaSessionStorage {},
}));
vi.mock("../app/db.server", () => ({ default: {} }));

const GOOD_KEY = "a-sufficiently-long-and-random-encryption-key-for-tests-0123456789";

let originalKey;
beforeEach(() => {
  originalKey = process.env.ENCRYPTION_KEY;
  // Present so the unrelated missing-var check stays quiet and does not
  // confuse the assertions below.
  process.env.SHOPIFY_API_KEY ||= "test-api-key";
  process.env.SHOPIFY_API_SECRET ||= "test-api-secret";
  process.env.SHOPIFY_APP_URL ||= "https://example.test";
  vi.resetModules(); // force the module body to re-run on each import
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describe("app boot: encryption key guard", () => {
  it("boots when ENCRYPTION_KEY is valid", async () => {
    process.env.ENCRYPTION_KEY = GOOD_KEY;

    const mod = await import("../app/shopify.server.js");
    expect(mod.default).toBeDefined();
  });

  // The point of the guard: encrypt() throws on write, so without this the
  // first store to connect would hit the failure mid-OAuth. Boot is where a
  // configuration mistake should surface.
  it("refuses to boot when ENCRYPTION_KEY is missing", async () => {
    delete process.env.ENCRYPTION_KEY;

    await expect(import("../app/shopify.server.js")).rejects.toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("refuses to boot when ENCRYPTION_KEY is too short", async () => {
    process.env.ENCRYPTION_KEY = "too-short";

    await expect(import("../app/shopify.server.js")).rejects.toThrow(/too short/i);
  });

  it("refuses to boot when ENCRYPTION_KEY is a long but entropy-free placeholder", async () => {
    process.env.ENCRYPTION_KEY = "x".repeat(64);

    await expect(import("../app/shopify.server.js")).rejects.toThrow(/no entropy/i);
  });
});

// The billing safety net. isTestCharge() in app.billing.jsx is
// `NODE_ENV !== "production"` and nothing else, so NODE_ENV=production on a
// developer's machine turns a "Subscribe" click into a request for a REAL
// recurring charge. NODE_ENV is pinned to development by the dev command, but
// the mistake this guards against — copying the server's .env down to a laptop
// — is precisely the one that would otherwise slip past unnoticed.
describe("app boot: production-env-on-a-dev-machine guard", () => {
  let originalNodeEnv, originalAppUrl;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalAppUrl = process.env.SHOPIFY_APP_URL;
    process.env.ENCRYPTION_KEY = GOOD_KEY; // isolate this guard from the one above
  });
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
    else process.env.SHOPIFY_APP_URL = originalAppUrl;
  });

  const devHosts = [
    ["a Cloudflare dev tunnel", "https://abc-def-ghi.trycloudflare.com"],
    ["localhost", "http://localhost:3000"],
    ["a loopback IP", "http://127.0.0.1:3000"],
    ["an ngrok tunnel", "https://abcd1234.ngrok-free.app"],
  ];

  for (const [label, url] of devHosts) {
    it(`refuses to boot with NODE_ENV=production served from ${label}`, async () => {
      process.env.NODE_ENV = "production";
      process.env.SHOPIFY_APP_URL = url;

      await expect(import("../app/shopify.server.js")).rejects.toThrow(/NODE_ENV=production with a development app URL/);
    });

    it(`boots normally with NODE_ENV=development served from ${label}`, async () => {
      process.env.NODE_ENV = "development";
      process.env.SHOPIFY_APP_URL = url;

      const mod = await import("../app/shopify.server.js");
      expect(mod.default).toBeDefined();
    });
  }

  it("boots in production when the app URL is the real production host", async () => {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_APP_URL = "https://importzo.dazzletech.co";

    const mod = await import("../app/shopify.server.js");
    expect(mod.default).toBeDefined();
  });

  // A missing or malformed SHOPIFY_APP_URL is the missing-vars case handled
  // above it, which logs. This guard must not escalate that into a dead process.
  it("stays out of the way when SHOPIFY_APP_URL is absent", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SHOPIFY_APP_URL;

    const mod = await import("../app/shopify.server.js");
    expect(mod.default).toBeDefined();
  });

  it("stays out of the way when SHOPIFY_APP_URL is unparseable", async () => {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_APP_URL = "not-a-url";

    const mod = await import("../app/shopify.server.js");
    expect(mod.default).toBeDefined();
  });
});
