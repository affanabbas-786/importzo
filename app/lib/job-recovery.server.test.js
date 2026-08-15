import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recoverOrphanedJobs,
  RUNNING_STALE_MS,
  PENDING_STALE_MS,
  ABANDON_AFTER_MS,
  MAX_RESUMES_PER_TICK,
  ABANDON_MESSAGE,
} from "./job-recovery.server.js";

const NOW = new Date("2026-08-15T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms);

function fakePrisma(jobs, { findThrows = null, updateThrows = null } = {}) {
  return {
    migrationJob: {
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
