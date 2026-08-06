import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertDatabaseMatchesEnv, isProductionDatabaseUrl } from "../app/lib/database-guard.js";

const execFileAsync = promisify(execFile);

// Stubbed so importing the real app/db.server.js stays inert — the assertion
// below is that no client is constructed at all when the guard trips.
vi.mock("@prisma/client", () => ({
  PrismaClient: class PrismaClient {
    constructor() {
      global.__prismaConstructed?.();
    }
    $executeRawUnsafe = async () => 0;
  },
}));

const PROD_URL = "file:./production.sqlite";
const DEV_URL = "file:./dev.sqlite";

describe("database guard: predicate", () => {
  it.each([
    ["file:./production.sqlite", true],
    ["file:./prisma/production.sqlite", true],
    ["file:/var/www/PRODUCTION.sqlite", true],
    ["file:./production-clone.sqlite", true],
    ["file:./dev.sqlite", false],
    ["file:./prisma/dev.sqlite", false],
    ["file::memory:", false],
    ["", false],
    [undefined, false],
  ])("isProductionDatabaseUrl(%s) === %s", (url, expected) => {
    expect(isProductionDatabaseUrl(url)).toBe(expected);
  });

  it("throws when a development process points at the production database", () => {
    expect(() => assertDatabaseMatchesEnv({ nodeEnv: "development", databaseUrl: PROD_URL }))
      .toThrow(/DATABASE_URL points at the production database/);
  });

  it("throws when the test runner points at the production database", () => {
    expect(() => assertDatabaseMatchesEnv({ nodeEnv: "test", databaseUrl: PROD_URL }))
      .toThrow(/DATABASE_URL points at the production database/);
  });

  // An unset NODE_ENV is never the production process — PM2 pins it in
  // ecosystem.importzo.config.cjs — so "unset" must read as "not production".
  it("throws when NODE_ENV is unset and the URL is production", () => {
    expect(() => assertDatabaseMatchesEnv({ nodeEnv: undefined, databaseUrl: PROD_URL }))
      .toThrow(/NODE_ENV=\(unset\)/);
  });

  it("allows production to use the production database", () => {
    expect(() => assertDatabaseMatchesEnv({ nodeEnv: "production", databaseUrl: PROD_URL }))
      .not.toThrow();
  });

  it.each(["development", "test", undefined])("allows NODE_ENV=%s with a dev database", (nodeEnv) => {
    expect(() => assertDatabaseMatchesEnv({ nodeEnv, databaseUrl: DEV_URL })).not.toThrow();
  });

  it("stays out of the way when DATABASE_URL is unset", () => {
    expect(() => assertDatabaseMatchesEnv({ nodeEnv: "development", databaseUrl: undefined }))
      .not.toThrow();
  });
});

// The guard's real job is refusing to construct a client, so this imports the
// REAL app/db.server.js with only Prisma itself stubbed.
describe("database guard: db.server boot refuse", () => {
  let originalNodeEnv, originalDbUrl;
  const constructed = vi.fn();

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDbUrl = process.env.DATABASE_URL;
    constructed.mockClear();
    delete global.prismaGlobal;
    vi.resetModules();
  });
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    delete global.prismaGlobal;
  });

  it("refuses to boot, and never constructs a client, in dev against production.sqlite", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = PROD_URL;
    global.__prismaConstructed = constructed;

    await expect(import("../app/db.server.js")).rejects.toThrow(/production database/);
    expect(constructed).not.toHaveBeenCalled();
  });

  it("boots in dev against dev.sqlite", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = DEV_URL;
    global.__prismaConstructed = constructed;

    const mod = await import("../app/db.server.js");
    expect(mod.default).toBeDefined();
    expect(constructed).toHaveBeenCalled();
  });

  it("boots in production against production.sqlite", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = PROD_URL;
    global.__prismaConstructed = constructed;

    const mod = await import("../app/db.server.js");
    expect(mod.default).toBeDefined();
    expect(constructed).toHaveBeenCalled();
  });
});

// The pre-boot gate, which is what actually stands between `prisma migrate
// deploy` and the production database. Run as a real subprocess, because its
// contract is the exit code the dev command's `&&` chain depends on.
describe("database guard: pre-boot script (scripts/assert-dev-database.mjs)", () => {
  const run = (env) =>
    execFileAsync("node", ["scripts/assert-dev-database.mjs"], {
      env: { PATH: process.env.PATH, ...env },
    });

  it("exits non-zero and explains, so the dev command's && chain halts", async () => {
    await expect(run({ DATABASE_URL: PROD_URL })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/production database/),
    });
  });

  // The trap this script exists to avoid: a .env copied from the server carries
  // NODE_ENV=production, and the Shopify CLI merges it into this process. The
  // script must refuse anyway rather than read that as "production is fine".
  it("still refuses when a production .env has set NODE_ENV=production", async () => {
    await expect(run({ DATABASE_URL: PROD_URL, NODE_ENV: "production" })).rejects.toMatchObject({
      code: 1,
    });
  });

  it("exits zero for a dev database", async () => {
    const { stderr } = await run({ DATABASE_URL: DEV_URL });
    expect(stderr).toBe("");
  });
});
