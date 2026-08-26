import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recoverOrphanedJobs,
  recoverOrphanedThemeJobs,
  RUNNING_STALE_MS,
  PENDING_STALE_MS,
  ABANDON_AFTER_MS,
  MAX_RESUMES_PER_TICK,
  ABANDON_MESSAGE,
  THEME_ABANDON_MESSAGE,
} from "./job-recovery.server.js";

const NOW = new Date("2026-08-15T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms);

// The delegate name is a parameter because recoverOrphanedJobs and
// recoverOrphanedThemeJobs drive the SAME loop against DIFFERENT tables. A
// fake that only ever exposed migrationJob would let a theme-side regression
// — wrong delegate, dropped phase select — pass every test in this file while
// the theme path was in fact broken.
function fakePrisma(jobs, { findThrows = null, updateThrows = null, model = "migrationJob" } = {}) {
  return {
    [model]: {
      findMany: vi.fn(async ({ where }) => {
        if (findThrows) throw new Error(findThrows);
        // Mirror the route's own filter so tests exercise the real predicate.
        const cutoff = where.updatedAt.lt;
        return jobs
          .filter((j) => where.status.in.includes(j.status) && j.updatedAt < cutoff)
          .sort((a, b) => a.updatedAt - b.updatedAt);
      }),
      update: vi.fn(async () => {
        if (updateThrows) throw new Error(updateThrows);
        return {};
      }),
    },
  };
}

function job(overrides = {}) {
  return {
    id: "job-1",
    shop: "shop.myshopify.com",
    status: "RUNNING",
    createdAt: ago(60 * 60 * 1000),
    updatedAt: ago(RUNNING_STALE_MS + 60_000),
    ...overrides,
  };
}

let runWorker;
let neverActive;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  runWorker = vi.fn(async () => {});
  neverActive = () => false;
});

describe("recoverOrphanedJobs", () => {
  it("resumes a RUNNING job whose worker died with the process", async () => {
    const prisma = fakePrisma([job()]);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(runWorker).toHaveBeenCalledWith("job-1");
    expect(result.resumed).toEqual([{ id: "job-1", shop: "shop.myshopify.com", status: "RUNNING" }]);
  });

  it("resumes a PENDING job that was created but never started", async () => {
    const prisma = fakePrisma([job({ status: "PENDING", updatedAt: ago(PENDING_STALE_MS + 1000) })]);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0].status).toBe("PENDING");
  });

  it("never restarts a job that is still running in THIS process", async () => {
    const prisma = fakePrisma([job()]);

    const result = await recoverOrphanedJobs({ prisma, isActive: () => true, runWorker, now: NOW });

    expect(runWorker).not.toHaveBeenCalled();
    expect(result.resumed).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("leaves a RUNNING job alone until it has been quiet past the RUNNING threshold", async () => {
    // Past PENDING_STALE_MS (so the query returns it) but well inside
    // RUNNING_STALE_MS — a healthy worker mid-backup must not be re-entered.
    const prisma = fakePrisma([job({ updatedAt: ago(PENDING_STALE_MS + 60_000) })]);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(runWorker).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("fails a job interrupted for more than 24 hours instead of resuming it forever", async () => {
    const prisma = fakePrisma([job({ createdAt: ago(ABANDON_AFTER_MS + 60_000) })]);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(runWorker).not.toHaveBeenCalled();
    expect(result.abandoned).toEqual([{ id: "job-1", shop: "shop.myshopify.com" }]);
    const update = prisma.migrationJob.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "job-1" });
    expect(update.data.status).toBe("FAILED");
    expect(JSON.parse(update.data.errorLog)[0].error).toBe(ABANDON_MESSAGE);
  });

  it("tells the merchant a re-run with skip is how to continue, not that data was lost", () => {
    expect(ABANDON_MESSAGE).toMatch(/nothing already transferred was removed/i);
    expect(ABANDON_MESSAGE).toMatch(/skip/);
  });

  it("caps how many workers one tick may start", async () => {
    const many = Array.from({ length: MAX_RESUMES_PER_TICK + 2 }, (_, i) =>
      job({ id: `job-${i}`, updatedAt: ago(RUNNING_STALE_MS + 60_000 + i) }));
    const prisma = fakePrisma(many);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.resumed).toHaveLength(MAX_RESUMES_PER_TICK);
    expect(result.skipped).toBe(2);
  });

  it("abandoning is not subject to the resume cap — a stuck job gets failed either way", async () => {
    const jobs = [
      ...Array.from({ length: MAX_RESUMES_PER_TICK }, (_, i) =>
        job({ id: `fresh-${i}`, updatedAt: ago(RUNNING_STALE_MS + 60_000 + i) })),
      job({ id: "ancient", createdAt: ago(ABANDON_AFTER_MS * 2), updatedAt: ago(ABANDON_AFTER_MS) }),
    ];
    const prisma = fakePrisma(jobs);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.abandoned.map((j) => j.id)).toEqual(["ancient"]);
  });

  it("a crash inside the resumed worker never propagates out of the tick", async () => {
    const prisma = fakePrisma([job()]);
    const exploding = vi.fn(() => Promise.reject(new Error("worker blew up")));

    await expect(
      recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker: exploding, now: NOW }),
    ).resolves.toMatchObject({ resumed: [{ id: "job-1" }] });
  });

  it("reports a query failure rather than throwing into the scheduler tick", async () => {
    const prisma = fakePrisma([], { findThrows: "database is locked" });

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.error).toBe("database is locked");
    expect(result.resumed).toEqual([]);
  });

  it("survives a failure while marking a job abandoned", async () => {
    const prisma = fakePrisma([job({ createdAt: ago(ABANDON_AFTER_MS * 2) })], { updateThrows: "readonly database" });

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.abandoned).toEqual([]);
  });

  it("ignores jobs that already finished", async () => {
    const prisma = fakePrisma([
      job({ id: "done", status: "COMPLETED" }),
      job({ id: "dead", status: "FAILED" }),
    ]);

    const result = await recoverOrphanedJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.resumed).toEqual([]);
    expect(prisma.migrationJob.update).not.toHaveBeenCalled();
  });
});

// ── Theme transfers ────────────────────────────────────────────────────────
// recoverOrphanedThemeJobs shares recoverStale with the migration path, so
// the threshold/cap/abandon rules are covered above. What is NOT shared — and
// therefore what these cover — is the three things that differ per job type:
// the Prisma delegate it reads, the extra `phase` column it selects, and the
// abandon message the merchant actually receives.

function themeJob(overrides = {}) {
  return {
    id: "theme-1",
    shop: "dest.myshopify.com",
    status: "RUNNING",
    phase: "FETCHING",
    createdAt: ago(60 * 60 * 1000),
    updatedAt: ago(RUNNING_STALE_MS + 60_000),
    ...overrides,
  };
}

const themePrisma = (jobs, opts = {}) => fakePrisma(jobs, { ...opts, model: "themeJob" });

describe("recoverOrphanedThemeJobs", () => {
  it("resumes a theme transfer whose worker died with the process", async () => {
    const prisma = themePrisma([themeJob()]);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(runWorker).toHaveBeenCalledWith("theme-1");
    expect(result.resumed).toEqual([{ id: "theme-1", shop: "dest.myshopify.com", status: "RUNNING" }]);
  });

  it("reads themeJob, never migrationJob", async () => {
    // Guards the one bug a shared loop makes easy: passing the wrong delegate
    // would silently recover the wrong table's jobs with the wrong worker.
    const prisma = themePrisma([themeJob()]);
    prisma.migrationJob = { findMany: vi.fn(), update: vi.fn() };

    await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(prisma.themeJob.findMany).toHaveBeenCalled();
    expect(prisma.migrationJob.findMany).not.toHaveBeenCalled();
  });

  it("selects `phase` so a resume can be traced to the step it died on", async () => {
    // phase is the only column the theme path adds to the shared select. It is
    // what makes "resuming job=… phase=FETCHING" legible in the logs, and it is
    // trivially droppable in a refactor, so it is pinned here.
    const prisma = themePrisma([themeJob()]);

    await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    const { select } = prisma.themeJob.findMany.mock.calls[0][0];
    expect(select).toMatchObject({ id: true, shop: true, status: true, phase: true });
  });

  it("names the phase in the resume log", async () => {
    const prisma = themePrisma([themeJob({ phase: "CREATING" })]);

    await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("phase=CREATING"));
  });

  it("resumes a stale CREATING job rather than failing it — the by-name check adopts", async () => {
    // The riskiest phase to re-enter: a crash after Shopify created the theme
    // but before newThemeId was persisted. Re-running is safe because the
    // worker adopts a destination theme matching the stored name instead of
    // creating a second one, which is why this is a resume and not an abandon.
    const prisma = themePrisma([themeJob({ phase: "CREATING", newThemeId: null })]);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.resumed).toHaveLength(1);
    expect(prisma.themeJob.update).not.toHaveBeenCalled();
  });

  it("never restarts a theme job still running in THIS process", async () => {
    const prisma = themePrisma([themeJob()]);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: () => true, runWorker, now: NOW });

    expect(runWorker).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("leaves a RUNNING theme job alone until it passes the RUNNING threshold", async () => {
    const prisma = themePrisma([themeJob({ updatedAt: ago(PENDING_STALE_MS + 60_000) })]);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(runWorker).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("abandons a theme job with the THEME message, not the migration one", async () => {
    const prisma = themePrisma([themeJob({ createdAt: ago(ABANDON_AFTER_MS + 60_000) })]);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.abandoned).toEqual([{ id: "theme-1", shop: "dest.myshopify.com" }]);
    const update = prisma.themeJob.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    const written = JSON.parse(update.data.errorLog)[0].error;
    expect(written).toBe(THEME_ABANDON_MESSAGE);
    // The migration message tells the merchant to re-run with conflict mode
    // "skip". Themes have no such mode, so sending it here would be advice the
    // merchant cannot follow.
    expect(written).not.toBe(ABANDON_MESSAGE);
  });

  it("tells the merchant a re-run adopts the half-created theme instead of duplicating it", async () => {
    expect(THEME_ABANDON_MESSAGE).toMatch(/rather than creating a duplicate/i);
    expect(THEME_ABANDON_MESSAGE).toMatch(/still there and unpublished/i);
    // Must NOT inherit the migration wording — there is no "skip" conflict
    // mode on a theme transfer.
    expect(THEME_ABANDON_MESSAGE).not.toMatch(/conflict handling set to/i);
  });

  it("caps theme resumes per tick with the same ceiling as migrations", async () => {
    const many = Array.from({ length: MAX_RESUMES_PER_TICK + 2 }, (_, i) =>
      themeJob({ id: `theme-${i}`, updatedAt: ago(RUNNING_STALE_MS + 60_000 + i) }));
    const prisma = themePrisma(many);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.resumed).toHaveLength(MAX_RESUMES_PER_TICK);
    expect(result.skipped).toBe(2);
  });

  it("reports a themeJob query failure rather than throwing into the scheduler tick", async () => {
    const prisma = themePrisma([], { findThrows: "database is locked" });

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.error).toBe("database is locked");
    expect(result.resumed).toEqual([]);
  });

  it("ignores theme jobs that already finished", async () => {
    const prisma = themePrisma([
      themeJob({ id: "done", status: "COMPLETED" }),
      themeJob({ id: "dead", status: "FAILED" }),
    ]);

    const result = await recoverOrphanedThemeJobs({ prisma, isActive: neverActive, runWorker, now: NOW });

    expect(result.resumed).toEqual([]);
    expect(prisma.themeJob.update).not.toHaveBeenCalled();
  });
});
