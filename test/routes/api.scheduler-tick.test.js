import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = { schedules: [] };

vi.mock("../../app/db.server", () => ({
  default: {
    scheduledSync: {
      findMany: vi.fn(async ({ where, take }) => db.schedules
        .filter((s) => s.enabled === where.enabled && new Date(s.nextRunAt) <= where.nextRunAt.lte)
        .slice(0, take)),
      update: vi.fn(async ({ where: { id }, data }) => {
        const row = db.schedules.find((s) => s.id === id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    migrationJob: { findUnique: vi.fn(async () => null) },
  },
}));

const startedJobs = [];
vi.mock("../../app/routes/api.scheduled-sync", () => ({
  startJobFromSchedule: vi.fn(async (schedule) => {
    const id = `job-${startedJobs.length + 1}`;
    startedJobs.push({ id, scheduleId: schedule.id });
    return id;
  }),
}));

const workerRuns = [];
vi.mock("../../app/lib/migration-worker.server", () => ({
  runMigrationWorker: vi.fn(async (jobId) => { workerRuns.push(jobId); }),
}));

import { action } from "../../app/routes/api.scheduler-tick.jsx";

const SECRET = "s3cr3t-value";

function tickRequest({ secret = SECRET, method = "POST" } = {}) {
  return {
    method,
    headers: { get: (name) => (name.toLowerCase() === "x-scheduler-secret" ? secret : null) },
  };
}

function seedDueSchedule(overrides = {}) {
  const row = {
    id: "sched-1",
    shop: "dest.myshopify.com",
    sourceShop: "source.myshopify.com",
    frequency: "daily",
    hourUtc: 3,
    dayOfWeek: null,
    conflictMode: "skip",
    enabled: true,
    nextRunAt: new Date(Date.now() - 60_000), // due
    lastJobId: null,
    consecutiveFailures: 0,
    ...overrides,
  };
  db.schedules.push(row);
  return row;
}

describe("api.scheduler-tick", () => {
  beforeEach(() => {
    db.schedules = [];
    startedJobs.length = 0;
    workerRuns.length = 0;
    process.env.SCHEDULER_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.SCHEDULER_SECRET;
    vi.restoreAllMocks();
  });

  it("runs due schedules and kicks off their workers", async () => {
    seedDueSchedule();
    const body = await (await action({ request: tickRequest() })).json();

    expect(body.ok).toBe(true);
    expect(body.ran).toHaveLength(1);
    expect(startedJobs).toHaveLength(1);
    expect(workerRuns).toEqual(["job-1"]);
  });

  it("401s on a wrong secret without running anything", async () => {
    seedDueSchedule();
    const response = await action({ request: tickRequest({ secret: "wrong" }) });

    expect(response.status).toBe(401);
    expect(startedJobs).toHaveLength(0);
  });

  it("401s when no secret header is sent at all", async () => {
    seedDueSchedule();
    const response = await action({ request: tickRequest({ secret: null }) });
    expect(response.status).toBe(401);
    expect(startedJobs).toHaveLength(0);
  });

  it("refuses to run when SCHEDULER_SECRET is unset, rather than defaulting open", async () => {
    delete process.env.SCHEDULER_SECRET;
    seedDueSchedule();

    const response = await action({ request: tickRequest({ secret: "anything" }) });

    expect(response.status).toBe(503);
    expect(startedJobs).toHaveLength(0);
  });

  it("rejects non-POST", async () => {
    const response = await action({ request: tickRequest({ method: "GET" }) });
    expect(response.status).toBe(405);
  });

  it("is a no-op when nothing is due", async () => {
    seedDueSchedule({ nextRunAt: new Date(Date.now() + 3600_000) });
    const body = await (await action({ request: tickRequest() })).json();

    expect(body.ran).toEqual([]);
    expect(startedJobs).toHaveLength(0);
  });
});
