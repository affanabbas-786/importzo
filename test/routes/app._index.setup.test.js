import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// The dashboard's setup state — what drives onboarding vs the
// "is this working?" strip (Built for Shopify 4.2.2 and 4.2.3).
//
// The rule that matters: a shop counts as started if it has EITHER moved
// something from another store OR imported a CSV. Importzo has two unrelated
// jobs and plenty of merchants only ever want one, so treating a CSV-only shop
// as "not set up" would leave it permanently onboarding.
//
// Also pinned: the saved source store carries a DECRYPTED access token, and
// only its domain may reach the browser.
// ═══════════════════════════════════════════════════════════════════

const { db, authenticateMock, savedSourceMock } = vi.hoisted(() => ({
  db: {
    importJob: { findMany: vi.fn(async () => []) },
    migrationJob: { count: vi.fn(async () => 0) },
    themeJob: { count: vi.fn(async () => 0) },
  },
  authenticateMock: vi.fn(async () => ({ session: { shop: "dest.myshopify.com" } })),
  savedSourceMock: vi.fn(async () => null),
}));

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../app/db.server", () => ({ default: db }));
vi.mock("../../app/lib/safe-db", () => ({ getSavedSourceStore: savedSourceMock }));

const { loader } = await import("../../app/routes/app._index.jsx");

beforeEach(() => {
  db.importJob.findMany.mockReset().mockResolvedValue([]);
  db.migrationJob.count.mockReset().mockResolvedValue(0);
  db.themeJob.count.mockReset().mockResolvedValue(0);
  savedSourceMock.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const run = () => loader({ request: {} });

describe("dashboard setup state", () => {
  it("reports a brand-new shop as having done nothing", async () => {
    const { setup } = await run();
    expect(setup).toMatchObject({ sourceShop: null, transfers: 0, csvImports: 0, lastRunAt: null });
  });

  it("counts product migrations and theme transfers together as transfers", async () => {
    db.migrationJob.count.mockResolvedValue(2);
    db.themeJob.count.mockResolvedValue(3);
    const { setup } = await run();
    expect(setup.transfers).toBe(5);
  });

  it("surfaces the connected source store by domain only, never its token", async () => {
    savedSourceMock.mockResolvedValue({ sourceUrl: "old.myshopify.com", token: "shpat_plaintext" });
    const result = await run();
    expect(result.setup.sourceShop).toBe("old.myshopify.com");
    expect(JSON.stringify(result)).not.toContain("shpat_plaintext");
  });

  it("treats a CSV-only shop as started, with no source store", async () => {
    db.importJob.findMany.mockResolvedValue([
      { id: "1", createdAt: new Date("2026-08-25T11:00:00Z"), successCount: 3, errorCount: 0, status: "completed" },
    ]);
    const { setup } = await run();
    expect(setup.csvImports).toBe(1);
    expect(setup.transfers).toBe(0);
    expect(setup.sourceShop).toBeNull();
    expect(setup.lastRunAt).toBe("2026-08-25T11:00:00.000Z");
  });

  it("still renders when the SourceStore table isn't there yet", async () => {
    // safe-db creates it lazily; a brand-new install must not see a broken
    // dashboard just because nothing has touched that table.
    savedSourceMock.mockRejectedValue(new Error("no such table: SourceStore"));
    const { setup } = await run();
    expect(setup.sourceShop).toBeNull();
  });

  it("still renders when a count query fails", async () => {
    db.themeJob.count.mockRejectedValue(new Error("no such table: ThemeJob"));
    db.migrationJob.count.mockResolvedValue(1);
    const { setup } = await run();
    expect(setup.transfers).toBe(1);
  });

  it("survives the import-job query failing entirely", async () => {
    db.importJob.findMany.mockRejectedValue(new Error("database is locked"));
    const result = await run();
    expect(result.imports).toEqual([]);
    expect(result.setup.csvImports).toBe(0);
  });

  it("scopes every query to this shop", async () => {
    await run();
    expect(db.importJob.findMany.mock.calls[0][0].where).toEqual({ shop: "dest.myshopify.com" });
    expect(db.migrationJob.count.mock.calls[0][0].where).toEqual({ shop: "dest.myshopify.com" });
    expect(db.themeJob.count.mock.calls[0][0].where).toEqual({ shop: "dest.myshopify.com" });
    expect(savedSourceMock).toHaveBeenCalledWith("dest.myshopify.com");
  });
});
