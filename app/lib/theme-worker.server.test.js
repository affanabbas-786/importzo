import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Staging is NOT mocked. It writes to tmpdir, which is fast, and the whole
// point of the resume tests is that the real isAssetStaged/stageAsset pair
// behaves correctly — a mocked Set would prove nothing about the code that
// actually runs.
import { stageAsset, clearStagedAssets } from "./theme-zip.server.js";

// ── in-memory ThemeJob row ────────────────────────────────────────────
let row;
const updates = []; // every patch, in order — lets us assert checkpoint ORDER

vi.mock("../db.server.js", () => ({
  default: {
    themeJob: {
      findUnique: vi.fn(async ({ where: { id } }) => (row && row.id === id ? { ...row } : null)),
      update: vi.fn(async ({ where: { id }, data }) => {
        if (!row || row.id !== id) throw new Error("Record to update not found.");
        updates.push({ ...data });
        Object.assign(row, data);
        return { ...row };
      }),
    },
  },
}));

vi.mock("../utils/encryption.server.js", () => ({
  decrypt: (v) => String(v || "").replace(/^enc:/, ""),
  encrypt: (v) => `enc:${v}`,
}));

const recordUsageAndCheck = vi.fn(async () => ({ limitReached: false }));
vi.mock("./usage.server.js", () => ({
  recordUsageAndCheck: (...a) => recordUsageAndCheck(...a),
}));

// Media upload is exercised by its own module's behaviour, not here — the
// worker's contract with it is just "call it, don't let it fail the job".
const createFilesOnTargetFromThemeRefs = vi.fn(async () => ({ total: 0, uploaded: 0, warnings: [] }));
vi.mock("./theme-media.server.js", () => ({
  extractThemeFileReferences: () => [],
  createFilesOnTargetFromThemeRefs: (...a) => createFilesOnTargetFromThemeRefs(...a),
}));

import { runThemeWorker, PHASE } from "./theme-worker.server.js";

const SOURCE = "src.myshopify.com";
const DEST = "dest.myshopify.com";
const THEME_NAME = "Dawn (Transferred)";

// Tokens: bypass the session-store provider entirely.
const fakeTokens = () => ({ get: async () => "tok" });

function makeJob(over = {}) {
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    shop: DEST,
    sourceShop: SOURCE,
    sourceThemeId: "123",
    sourceThemeName: "Dawn",
    targetThemeName: THEME_NAME,
    sourceToken: "enc:s", destToken: "enc:d",
    apiVersion: "2026-04",
    status: "PENDING",
    phase: PHASE.LISTING,
    assetsTotal: 0, assetsFetched: 0, assetsFailed: 0,
    newThemeId: null, zipId: null, zipToken: null,
    errorLog: "[]",
    ...over,
  };
}

function jsonRes(body, status = 200) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/**
 * Fake Shopify. `assetKeys` is the source manifest; `existingThemes` is what
 * the destination already has (drives the adoption guard); `onCreate` fires
 * when a theme is actually created, which is what the duplicate tests count.
 */
function mockShopify({ assetKeys, existingThemes = [], onCreate, createdId = "999", fetchFailKeys = [] } = {}) {
  const calls = { assetFetches: [], creates: 0, lists: 0 };
  global.fetch = vi.fn(async (url) => {
    const u = String(url);

    if (u.includes("/themes.json") && u.includes(DEST)) {
      calls.lists++;
      return jsonRes({ themes: existingThemes });
    }
    // Extraction poll. Serves the created theme AND any pre-existing one,
    // because an adopted theme is polled by ITS id, not the created one.
    const pollMatch = u.match(/\/themes\/(\d+)\.json/);
    if (pollMatch) {
      const id = pollMatch[1];
      const known = id === String(createdId) || existingThemes.some((t) => String(t.id) === id);
      if (!known) return jsonRes({}, 404);
      return jsonRes({ theme: { id, name: THEME_NAME, processing: false } });
    }
    if (u.includes("asset%5Bkey%5D=") || u.includes("asset[key]=")) {
      const key = decodeURIComponent(u.split(/asset(?:%5B|\[)key(?:%5D|\])=/)[1]);
      calls.assetFetches.push(key);
      if (fetchFailKeys.includes(key)) return jsonRes({}, 500);
      return jsonRes({ asset: { key, value: key === "layout/theme.liquid" ? "<html></html>" : `/* ${key} */` } });
    }
    if (u.includes("/assets.json")) {
      return jsonRes({ assets: assetKeys.map((key) => ({ key })) });
    }
    return jsonRes({}, 404);
  });

  // themes.json POST (create) shares the URL with the list — separate by method.
  const inner = global.fetch;
  global.fetch = vi.fn(async (url, opts) => {
    if (opts?.method === "POST" && String(url).includes("/themes.json")) {
      calls.creates++;
      onCreate?.();
      return jsonRes({ theme: { id: createdId, name: THEME_NAME, processing: true } });
    }
    return inner(url, opts);
  });

  return calls;
}

const run = (job) => runThemeWorker(job.id, { createTokens: fakeTokens });

describe("theme-worker", () => {
  beforeEach(() => {
    row = null;
    updates.length = 0;
    recordUsageAndCheck.mockClear();
    createFilesOnTargetFromThemeRefs.mockClear();
    // Extraction polls on a 5s timer; fake timers would fight the awaits, so
    // the fake reports processing:false immediately and the single 5s sleep
    // is tolerated. Kept short by using tiny manifests.
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (row?.id) await clearStagedAssets(row.id);
    vi.restoreAllMocks();
  });

  it("runs the whole pipeline and completes", async () => {
    row = makeJob();
    const calls = mockShopify({ assetKeys: ["layout/theme.liquid", "assets/app.css"] });

    await run(row);

    expect(row.status).toBe("COMPLETED");
    expect(row.assetsTotal).toBe(2);
    expect(row.assetsFetched).toBe(2);
    expect(row.newThemeId).toBe("999");
    expect(calls.creates).toBe(1);
  }, 20000);

  it("advances through every phase in order", async () => {
    row = makeJob();
    mockShopify({ assetKeys: ["layout/theme.liquid"] });

    await run(row);

    const phases = updates.filter((u) => u.phase).map((u) => u.phase);
    expect(phases).toEqual([
      PHASE.FETCHING, PHASE.PACKAGING, PHASE.MEDIA, PHASE.CREATING, PHASE.EXTRACTING, PHASE.EXTRACTING,
    ]);
  }, 20000);

  it("counts a completed theme as exactly one record", async () => {
    row = makeJob();
    mockShopify({ assetKeys: ["layout/theme.liquid"] });
    await run(row);
    expect(recordUsageAndCheck).toHaveBeenCalledTimes(1);
    expect(recordUsageAndCheck).toHaveBeenCalledWith(expect.objectContaining({ shop: DEST, count: 1 }));
  }, 20000);

  // ── the create-checkpoint hazard ────────────────────────────────────
  // newThemeId must be persisted BEFORE the first extraction poll, or a
  // crash in that window orphans a theme no job row knows about.
  it("persists newThemeId in the same update that leaves CREATING", async () => {
    row = makeJob();
    mockShopify({ assetKeys: ["layout/theme.liquid"] });

    await run(row);

    const write = updates.find((u) => u.newThemeId === "999");
    expect(write).toBeDefined();
    expect(write.phase).toBe(PHASE.EXTRACTING); // one atomic write, not two
  }, 20000);

  // ── adoption guard ──────────────────────────────────────────────────
  it("adopts an existing destination theme instead of creating a duplicate", async () => {
    row = makeJob({ phase: PHASE.CREATING, zipId: "z", zipToken: "t" });
    const calls = mockShopify({
      assetKeys: ["layout/theme.liquid"],
      existingThemes: [{ id: 555, name: THEME_NAME }],
    });

    await run(row);

    expect(calls.creates).toBe(0);       // the whole point
    expect(row.newThemeId).toBe("555");
    expect(row.status).toBe("COMPLETED");
  }, 20000);

  it("still creates when no destination theme matches the name", async () => {
    row = makeJob({ phase: PHASE.CREATING, zipId: "z", zipToken: "t" });
    const calls = mockShopify({
      assetKeys: ["layout/theme.liquid"],
      existingThemes: [{ id: 555, name: "Some Other Theme" }],
    });

    await run(row);

    expect(calls.creates).toBe(1);
    expect(row.newThemeId).toBe("999");
  }, 20000);

  it("does not consume a plan record when it only adopts an existing theme", async () => {
    row = makeJob({ existingThemes: [] });
    mockShopify({ assetKeys: ["layout/theme.liquid"], existingThemes: [{ id: 555, name: THEME_NAME }] });

    await run(row);

    expect(row.status).toBe("COMPLETED");
    expect(recordUsageAndCheck).not.toHaveBeenCalled();
  }, 20000);

  // ── staging resume ──────────────────────────────────────────────────
  it("skips assets already staged and fetches only the remainder", async () => {
    row = makeJob({ phase: PHASE.FETCHING, assetsTotal: 4 });
    const keys = ["layout/theme.liquid", "assets/a.css", "assets/b.css", "assets/c.css"];

    // Two of four already on disk from a previous, interrupted run.
    await stageAsset(row.id, "layout/theme.liquid", Buffer.from("<html></html>"));
    await stageAsset(row.id, "assets/a.css", Buffer.from("/* a */"));

    const calls = mockShopify({ assetKeys: keys });
    await run(row);

    expect(calls.assetFetches.sort()).toEqual(["assets/b.css", "assets/c.css"]);
    expect(row.assetsFetched).toBe(4); // all four present, only two downloaded
    expect(row.status).toBe("COMPLETED");
  }, 20000);

  it("records a failed asset as a warning without failing the job", async () => {
    row = makeJob();
    mockShopify({
      assetKeys: ["layout/theme.liquid", "assets/broken.css"],
      fetchFailKeys: ["assets/broken.css"],
    });

    await run(row);

    expect(row.status).toBe("COMPLETED");
    expect(row.assetsFailed).toBe(1);
    expect(JSON.parse(row.errorLog).some((e) => e.key === "assets/broken.css")).toBe(true);
  }, 20000);

  // ── fatal conditions ────────────────────────────────────────────────
  it("fails when the source theme has no layout/theme.liquid", async () => {
    row = makeJob();
    mockShopify({ assetKeys: ["assets/app.css"] });

    await run(row);

    expect(row.status).toBe("FAILED");
    expect(JSON.parse(row.errorLog).pop().error).toMatch(/layout\/theme\.liquid/);
  }, 20000);

  it("records the fatal error against the job rather than throwing", async () => {
    row = makeJob();
    global.fetch = vi.fn(async () => jsonRes({}, 401));

    await expect(run(row)).resolves.toBeUndefined();
    expect(row.status).toBe("FAILED");
    expect(JSON.parse(row.errorLog).pop().error).toMatch(/session expired|uninstalled/i);
  }, 20000);

  // ── worker registry ─────────────────────────────────────────────────
  it("is a no-op for a job that already finished", async () => {
    row = makeJob({ status: "COMPLETED" });
    global.fetch = vi.fn();
    await run(row);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("is a no-op for a job id that does not exist", async () => {
    row = null;
    global.fetch = vi.fn();
    await runThemeWorker("nope", { createTokens: fakeTokens });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
