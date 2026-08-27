import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// The loader behind the scheduled-sync screen.
//
// What matters here is what the page is TOLD, because that is what decides
// whether the create form is rendered disabled. Built for Shopify 4.3.7 wants
// plan-gated features disabled "both visually and functionally" — the server
// check in api.scheduled-sync.jsx is the real boundary, and `allowed` is what
// stops a Free merchant filling in a form that was always going to be refused.
//
// Also pinned: the access token never leaves the server. A schedule exists so
// credentials can outlive the session, which is exactly why they must not be
// handed to the browser.
// ═══════════════════════════════════════════════════════════════════

const { db, authenticateMock, usageMock, savedSourceMock } = vi.hoisted(() => ({
  db: { scheduledSync: { findMany: vi.fn(async () => []) } },
  authenticateMock: vi.fn(async () => ({ session: { shop: "dest.myshopify.com" } })),
  usageMock: vi.fn(),
  savedSourceMock: vi.fn(),
}));

vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../app/db.server", () => ({ default: db }));
vi.mock("../../app/lib/usage.server", () => ({ getUsageStatus: usageMock }));
vi.mock("../../app/lib/safe-db", () => ({ getSavedSourceStore: savedSourceMock }));

const { loader } = await import("../../app/routes/app.scheduled-sync.jsx");

const usage = (over = {}) => ({ label: "Free", scheduledSyncAllowed: false, ...over });

beforeEach(() => {
  db.scheduledSync.findMany.mockReset().mockResolvedValue([]);
  usageMock.mockReset().mockResolvedValue(usage());
  savedSourceMock.mockReset().mockResolvedValue({ sourceUrl: "src.myshopify.com", token: "shpat_secret" });
});

describe("app.scheduled-sync loader", () => {
  it("tells a Free shop the feature is not available", async () => {
    const result = await loader({ request: {} });
    expect(result.allowed).toBe(false);
    expect(result.planLabel).toBe("Free");
  });

  it("tells a Pro shop it is", async () => {
    usageMock.mockResolvedValue(usage({ label: "Pro", scheduledSyncAllowed: true }));
    const result = await loader({ request: {} });
    expect(result.allowed).toBe(true);
    expect(result.planLabel).toBe("Pro");
  });

  it("never sends the source store's access token to the browser", async () => {
    const result = await loader({ request: {} });
    expect(result.savedSource).toBe("src.myshopify.com");
    expect(JSON.stringify(result)).not.toContain("shpat_secret");
  });

  it("reports no source store rather than throwing when none is saved", async () => {
    savedSourceMock.mockResolvedValue(null);
    const result = await loader({ request: {} });
    expect(result.savedSource).toBeNull();
  });

  it("survives the source-store lookup failing", async () => {
    // getSavedSourceStore goes through safe-db for a reason; a missing table
    // must not take down the whole page.
    savedSourceMock.mockRejectedValue(new Error("no such table: SourceStore"));
    const result = await loader({ request: {} });
    expect(result.savedSource).toBeNull();
    expect(result.allowed).toBe(false);
  });

  it("scopes the query to this shop and selects no token columns", async () => {
    await loader({ request: {} });
    const args = db.scheduledSync.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ shop: "dest.myshopify.com" });
    expect(args.select.sourceToken).toBeUndefined();
    expect(args.select.destToken).toBeUndefined();
  });

  it("serialises dates so the component can format them", async () => {
    db.scheduledSync.findMany.mockResolvedValue([{
      id: "s1", sourceShop: "src.myshopify.com", frequency: "daily", hourUtc: 3,
      dayOfWeek: null, conflictMode: "skip", enabled: true,
      nextRunAt: new Date("2026-09-01T03:00:00Z"),
      lastRunAt: null,
      createdAt: new Date("2026-08-20T10:00:00Z"),
    }]);
    const [s] = (await loader({ request: {} })).schedules;
    expect(s.nextRunAt).toBe("2026-09-01T03:00:00.000Z");
    expect(s.lastRunAt).toBeNull();
    expect(s.createdAt).toBe("2026-08-20T10:00:00.000Z");
  });
});
