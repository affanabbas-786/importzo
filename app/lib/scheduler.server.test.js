import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FREQUENCY, MAX_CONSECUTIVE_FAILURES, isValidFrequency, computeNextRun,
  findDueSchedules, hasRunInFlight, runScheduledSyncs, disableForAuthFailure, isAuthError, disableForPlanRequirement,
} from "./scheduler.server.js";

function schedule(overrides = {}) {
  return {
    id: "sched-1",
    shop: "dest.myshopify.com",
    sourceShop: "source.myshopify.com",
    frequency: FREQUENCY.DAILY,
    hourUtc: 3,
    dayOfWeek: null,
    conflictMode: "skip",
    enabled: true,
    nextRunAt: new Date("2026-01-01T03:00:00Z"),
    lastRunAt: null,
    lastJobId: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function fakePrisma({ schedules = [], jobs = {} } = {}) {
  const rows = schedules.map((s) => ({ ...s }));
  return {
    scheduledSync: {
      findMany: vi.fn(async ({ where, take }) => rows
        .filter((s) => s.enabled === where.enabled && new Date(s.nextRunAt) <= where.nextRunAt.lte)
        .slice(0, take)),
      update: vi.fn(async ({ where: { id }, data }) => {
        const row = rows.find((s) => s.id === id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    migrationJob: {
      findUnique: vi.fn(async ({ where: { id } }) => jobs[id] || null),
    },
    __rows: () => rows,
  };
}

describe("isValidFrequency", () => {
  it("accepts the supported frequencies and rejects anything else", () => {
    expect(isValidFrequency("hourly")).toBe(true);
    expect(isValidFrequency("daily")).toBe(true);
    expect(isValidFrequency("weekly")).toBe(true);
    expect(isValidFrequency("fortnightly")).toBe(false);
    expect(isValidFrequency(undefined)).toBe(false);
  });
});

describe("computeNextRun", () => {
  it("hourly: rolls to the next hour boundary", () => {
    const next = computeNextRun(schedule({ frequency: FREQUENCY.HOURLY }), new Date("2026-01-01T10:17:33Z"));
    expect(next.toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });

  it("daily: picks today's hour when it's still ahead", () => {
    const next = computeNextRun(schedule({ hourUtc: 15 }), new Date("2026-01-01T10:00:00Z"));
    expect(next.toISOString()).toBe("2026-01-01T15:00:00.000Z");
  });

  it("daily: rolls to tomorrow once today's hour has passed", () => {
    const next = computeNextRun(schedule({ hourUtc: 3 }), new Date("2026-01-01T10:00:00Z"));
    expect(next.toISOString()).toBe("2026-01-02T03:00:00.000Z");
  });

  it("daily: rolls forward when exactly at the scheduled hour, never returning the current instant", () => {
    // Critical: returning `now` would make a due schedule re-fire every tick.
    const next = computeNextRun(schedule({ hourUtc: 3 }), new Date("2026-01-01T03:00:00Z"));
    expect(next.toISOString()).toBe("2026-01-02T03:00:00.000Z");
  });

  it("weekly: picks the next occurrence of the target weekday", () => {
    // 2026-01-01 is a Thursday (day 4); target Sunday (0).
    const next = computeNextRun(schedule({ frequency: FREQUENCY.WEEKLY, dayOfWeek: 0, hourUtc: 5 }), new Date("2026-01-01T10:00:00Z"));
    expect(next.getUTCDay()).toBe(0);
    expect(next.toISOString()).toBe("2026-01-04T05:00:00.000Z");
  });

  it("weekly: rolls a full week when today is the target day and the hour has passed", () => {
    const from = new Date("2026-01-01T10:00:00Z"); // Thursday
    const next = computeNextRun(schedule({ frequency: FREQUENCY.WEEKLY, dayOfWeek: 4, hourUtc: 5 }), from);
    expect(next.toISOString()).toBe("2026-01-08T05:00:00.000Z");
  });

  it("weekly: uses today when the target hour is still ahead", () => {
    const from = new Date("2026-01-01T02:00:00Z"); // Thursday, before 05:00
    const next = computeNextRun(schedule({ frequency: FREQUENCY.WEEKLY, dayOfWeek: 4, hourUtc: 5 }), from);
    expect(next.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("always returns a time strictly in the future", () => {
    const from = new Date("2026-06-15T12:34:56Z");
    for (const frequency of [FREQUENCY.HOURLY, FREQUENCY.DAILY, FREQUENCY.WEEKLY]) {
      for (let hourUtc = 0; hourUtc < 24; hourUtc += 6) {
        const next = computeNextRun(schedule({ frequency, hourUtc, dayOfWeek: 3 }), from);
        expect(next.getTime()).toBeGreaterThan(from.getTime());
      }
    }
  });

  it("falls back to a sane default for a malformed schedule", () => {
    const next = computeNextRun({}, new Date("2026-01-01T10:00:00Z"));
    expect(next.getTime()).toBeGreaterThan(new Date("2026-01-01T10:00:00Z").getTime());
  });
});

describe("findDueSchedules", () => {
  it("returns only enabled schedules whose slot has arrived", async () => {
    const prisma = fakePrisma();
    await findDueSchedules(prisma, new Date("2026-01-01T04:00:00Z"));
    expect(prisma.scheduledSync.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true, nextRunAt: { lte: new Date("2026-01-01T04:00:00Z") } },
      orderBy: { nextRunAt: "asc" },
    }));
  });
});

describe("hasRunInFlight", () => {
  it("is false when the schedule has never run", async () => {
    expect(await hasRunInFlight(fakePrisma(), schedule())).toBe(false);
  });

  it("is true while the previous job is RUNNING or PENDING", async () => {
    for (const status of ["RUNNING", "PENDING"]) {
      const prisma = fakePrisma({ jobs: { "job-1": { id: "job-1", status } } });
      expect(await hasRunInFlight(prisma, schedule({ lastJobId: "job-1" }))).toBe(true);
    }
  });

  it("is false once the previous job finished", async () => {
    for (const status of ["COMPLETED", "FAILED"]) {
      const prisma = fakePrisma({ jobs: { "job-1": { id: "job-1", status } } });
      expect(await hasRunInFlight(prisma, schedule({ lastJobId: "job-1" }))).toBe(false);
    }
  });

  it("is false when the referenced job no longer exists", async () => {
    expect(await hasRunInFlight(fakePrisma(), schedule({ lastJobId: "deleted" }))).toBe(false);
  });
});

describe("runScheduledSyncs", () => {
  const now = () => new Date("2026-01-01T04:00:00Z");

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("starts a job for each due schedule and advances its next run", async () => {
    const prisma = fakePrisma({ schedules: [schedule()] });
    const startJob = vi.fn(async () => "job-new");

    const result = await runScheduledSyncs({ prisma, startJob, now });

    expect(startJob).toHaveBeenCalledTimes(1);
    expect(result.ran).toHaveLength(1);
    const row = prisma.__rows()[0];
    expect(row.lastJobId).toBe("job-new");
    expect(new Date(row.nextRunAt).getTime()).toBeGreaterThan(now().getTime());
    expect(row.consecutiveFailures).toBe(0);
  });

  it("does not start a second run while the previous one is still going", async () => {
    const prisma = fakePrisma({
      schedules: [schedule({ lastJobId: "job-old" })],
      jobs: { "job-old": { id: "job-old", status: "RUNNING" } },
    });
    const startJob = vi.fn();

    const result = await runScheduledSyncs({ prisma, startJob, now });

    expect(startJob).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/still in progress/i);
    // Slot still advances, so it isn't re-examined every tick.
    expect(new Date(prisma.__rows()[0].nextRunAt).getTime()).toBeGreaterThan(now().getTime());
  });

  it("records a failure and retries next slot, without disabling on the first failure", async () => {
    const prisma = fakePrisma({ schedules: [schedule()] });
    const startJob = vi.fn(async () => { throw new Error("source unreachable"); });

    const result = await runScheduledSyncs({ prisma, startJob, now });

    expect(result.failed).toHaveLength(1);
    const row = prisma.__rows()[0];
    expect(row.consecutiveFailures).toBe(1);
    expect(row.enabled).toBe(true);
    expect(row.lastError).toMatch(/source unreachable/);
  });

  it("disables a schedule after repeated failures instead of retrying forever", async () => {
    const prisma = fakePrisma({ schedules: [schedule({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 })] });
    const startJob = vi.fn(async () => { throw new Error("401 Unauthorized"); });

    const result = await runScheduledSyncs({ prisma, startJob, now });

    expect(result.disabled).toHaveLength(1);
    const row = prisma.__rows()[0];
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toMatch(/consecutive failures/i);
    expect(row.disabledReason).toMatch(/401 Unauthorized/);
  });

  it("resets the failure counter after a successful run", async () => {
    const prisma = fakePrisma({ schedules: [schedule({ consecutiveFailures: 2 })] });
    const startJob = vi.fn(async () => "job-new");

    await runScheduledSyncs({ prisma, startJob, now });

    expect(prisma.__rows()[0].consecutiveFailures).toBe(0);
  });

  it("keeps processing the remaining schedules when one throws", async () => {
    const prisma = fakePrisma({ schedules: [schedule({ id: "a" }), schedule({ id: "b" }), schedule({ id: "c" })] });
    const startJob = vi.fn(async (s) => {
      if (s.id === "b") throw new Error("boom");
      return `job-${s.id}`;
    });

    const result = await runScheduledSyncs({ prisma, startJob, now });

    expect(result.ran.map((r) => r.id)).toEqual(["a", "c"]);
    expect(result.failed.map((r) => r.id)).toEqual(["b"]);
  });

  it("returns an error rather than throwing when schedules can't be loaded", async () => {
    const prisma = fakePrisma();
    prisma.scheduledSync.findMany = vi.fn(async () => { throw new Error("db down"); });

    const result = await runScheduledSyncs({ prisma, startJob: vi.fn(), now });

    expect(result.error).toMatch(/db down/);
    expect(result.ran).toEqual([]);
  });

  it("does nothing when no schedule is due", async () => {
    const prisma = fakePrisma({ schedules: [schedule({ nextRunAt: new Date("2026-01-02T03:00:00Z") })] });
    const startJob = vi.fn();

    const result = await runScheduledSyncs({ prisma, startJob, now });

    expect(startJob).not.toHaveBeenCalled();
    expect(result.ran).toEqual([]);
  });

  it("ignores disabled schedules even when their slot has passed", async () => {
    const prisma = fakePrisma({ schedules: [schedule({ enabled: false })] });
    const startJob = vi.fn();

    await runScheduledSyncs({ prisma, startJob, now });

    expect(startJob).not.toHaveBeenCalled();
  });
});

describe("auth-failure handling", () => {
  it("recognizes the error shapes an expired or revoked token produces", () => {
    expect(isAuthError(new Error("GraphQL HTTP 401: unauthorized"))).toBe(true);
    expect(isAuthError(new Error("HTTP 403 Forbidden"))).toBe(true);
    expect(isAuthError(new Error("Invalid API token"))).toBe(true);
    expect(isAuthError(new Error("token expired"))).toBe(true);
    expect(isAuthError(new Error("429 rate limited"))).toBe(false);
    expect(isAuthError(new Error("network timeout"))).toBe(false);
  });

  it("disables immediately on an auth failure, with a reason naming the fix", async () => {
    const prisma = fakePrisma({ schedules: [schedule()] });
    const reason = await disableForAuthFailure(prisma, "sched-1", "401");

    expect(reason).toMatch(/Reconnect the source store/i);
    const row = prisma.__rows()[0];
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toMatch(/no longer valid/i);
  });
});

// Billing audit (Phase 7): a plan-requirement failure (e.g. scheduled sync
// on a downgraded Free-tier shop) won't self-heal on retry, so it should
// disable on the first failed tick — same reasoning as disableForAuthFailure,
// just for a different permanent condition.
describe("disableForPlanRequirement", () => {
  it("disables immediately with the exact message passed in", async () => {
    const prisma = fakePrisma({ schedules: [schedule()] });
    const message = "Scheduled sync requires the Pro or Agency plan (currently on Free)";
    const reason = await disableForPlanRequirement(prisma, "sched-1", message);

    expect(reason).toBe(message);
    const row = prisma.__rows()[0];
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe(message);
    expect(row.lastError).toBe(message);
  });

  it("takes effect on the very first tick, not after MAX_CONSECUTIVE_FAILURES", async () => {
    const s = schedule({ consecutiveFailures: 0 });
    const prisma = fakePrisma({ schedules: [s] });
    const startJob = vi.fn(async (sched) => {
      const message = "Scheduled sync requires the Pro or Agency plan (currently on Free)";
      await disableForPlanRequirement(prisma, sched.id, message);
      throw new Error(message);
    });

    const results = await runScheduledSyncs({ prisma, startJob, now: () => new Date(s.nextRunAt.getTime() + 1000) });

    // Disabled on attempt 1, not left to accumulate toward MAX_CONSECUTIVE_FAILURES.
    const row = prisma.__rows()[0];
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toMatch(/requires the Pro or Agency plan/i);
    // runScheduledSyncs' own catch still records the failed attempt for
    // visibility, but must not clobber the reason disableForPlanRequirement
    // already set.
    expect(results.failed).toHaveLength(1);
  });
});
