import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = { schedules: [], plans: new Map(), jobs: [] };

function setShopPlan(shop, data) {
  db.plans.set(shop, {
    id: "plan-preset", shop, tier: "free", recordsUsed: 0, usagePeriodStart: new Date(),
    subscriptionId: null, subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...data,
  });
}

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
    migrationJob: {
      findUnique: vi.fn(async () => null),
      // Orphaned-job recovery (job-recovery.server.js) runs on every tick.
      findMany: vi.fn(async ({ where }) => db.jobs.filter(
        (j) => where.status.in.includes(j.status) && j.updatedAt < where.updatedAt.lt,
      )),
      update: vi.fn(async ({ where: { id }, data }) => {
        const row = db.jobs.find((j) => j.id === id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    // Phase 5: the tick's startJob wrapper checks getUsageStatus (scheduled
    // sync is Pro/Agency-only) before starting a job.
    shopPlan: {
      upsert: vi.fn(async ({ where: { shop }, update, create }) => {
        const existing = db.plans.get(shop);
        if (existing) { Object.assign(existing, update); return { ...existing }; }
        const row = {
          id: "plan-1", recordsUsed: 0, subscriptionId: null, subscriptionStatus: null,
          shopOwnerEmail: null, uninstalledAt: null, createdAt: new Date(), updatedAt: new Date(), ...create,
        };
        db.plans.set(shop, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = db.plans.get(shop);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        return { ...row };
      }),
    },
  },
}));

const startedJobs = [];
vi.mock("../../app/lib/scheduled-sync.server", () => ({
  startJobFromSchedule: vi.fn(async (schedule) => {
    const id = `job-${startedJobs.length + 1}`;
    startedJobs.push({ id, scheduleId: schedule.id });
    return id;
  }),
}));

const workerRuns = [];
const activeWorkers = new Set();
vi.mock("../../app/lib/migration-worker.server", () => ({
  runMigrationWorker: vi.fn(async (jobId) => { workerRuns.push(jobId); }),
  isWorkerActive: vi.fn((jobId) => activeWorkers.has(jobId)),
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
    db.plans = new Map();
    db.jobs = [];
    activeWorkers.clear();
    startedJobs.length = 0;
    workerRuns.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCHEDULER_SECRET = SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.SCHEDULER_SECRET;
    vi.restoreAllMocks();
  });

  it("runs due schedules and kicks off their workers", async () => {
    // Phase 5: scheduled sync is Pro/Agency-only — a due schedule for a
    // Free-tier shop is expected to be refused (see the billing-gate tests
    // below), so the happy path needs a plan that actually allows it.
    setShopPlan("dest.myshopify.com", { tier: "pro" });
    seedDueSchedule();
    const body = await (await action({ request: tickRequest() })).json();

    expect(body.ok).toBe(true);
    expect(body.ran).toHaveLength(1);
    expect(startedJobs).toHaveLength(1);
    expect(workerRuns).toEqual(["job-1"]);
  });

  // Billing audit (Phase 7): a schedule left on a downgraded Free-tier shop
  // must be disabled on the very first tick it's found due on, not left to
  // silently fail for MAX_CONSECUTIVE_FAILURES ticks first.
  it("disables a due schedule immediately (first tick) when its shop is on Free, with a clear reason", async () => {
    setShopPlan("dest.myshopify.com", { tier: "free" });
    const schedule = seedDueSchedule();

    const body = await (await action({ request: tickRequest() })).json();

    expect(body.ok).toBe(true);
    expect(startedJobs).toHaveLength(0); // no job ever started against the ineligible shop
    expect(schedule.enabled).toBe(false);
    expect(schedule.disabledReason).toMatch(/requires the Pro or Agency plan/i);
    expect(schedule.consecutiveFailures).toBe(1); // not accumulated toward MAX_CONSECUTIVE_FAILURES
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

  // ── Orphaned-job recovery ────────────────────────────────────────────────
  // The tick is the app's only periodic server-side hook, so it is the only
  // thing that can restart a migration whose worker died with the process and
  // that no merchant is polling. See job-recovery.server.js.

  function seedOrphanedJob(overrides = {}) {
    const row = {
      id: "orphan-1",
      shop: "shop.myshopify.com",
      status: "RUNNING",
      createdAt: new Date(Date.now() - 60 * 60_000),
      updatedAt: new Date(Date.now() - 30 * 60_000),
      ...overrides,
    };
    db.jobs.push(row);
    return row;
  }

  it("restarts a migration orphaned by a process restart, with nobody polling it", async () => {
    seedOrphanedJob();

    const body = await (await action({ request: tickRequest() })).json();

    expect(workerRuns).toContain("orphan-1");
    expect(body.recovery.resumed).toEqual([
      { id: "orphan-1", shop: "shop.myshopify.com", status: "RUNNING" },
    ]);
  });

  it("does not restart a migration that is still running in this process", async () => {
    seedOrphanedJob();
    activeWorkers.add("orphan-1");

    const body = await (await action({ request: tickRequest() })).json();

    expect(workerRuns).not.toContain("orphan-1");
    expect(body.recovery.resumed).toEqual([]);
  });

  it("reports recovery alongside the sync results without affecting tick success", async () => {
    seedDueSchedule({ nextRunAt: new Date(Date.now() + 3600_000) });

    const body = await (await action({ request: tickRequest() })).json();

    expect(body.ok).toBe(true);
    expect(body.recovery).toMatchObject({ resumed: [], abandoned: [] });
  });
});
