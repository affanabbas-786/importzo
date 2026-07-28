import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockActionRequest } from "../../app/lib/test-helpers.js";

const db = { schedules: [], jobs: [] };
const SHOP = "dest-shop.myshopify.com";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

function applySelect(row, select) {
  if (!row) return row;
  if (!select) return row;
  return Object.fromEntries(Object.entries(select).filter(([, v]) => v).map(([k]) => [k, row[k]]));
}

vi.mock("../../app/db.server", () => ({
  default: {
    scheduledSync: {
      findMany: vi.fn(async ({ where, select }) =>
        db.schedules.filter((s) => s.shop === where.shop).map((s) => applySelect(s, select))),
      findUnique: vi.fn(async ({ where: { id } }) => db.schedules.find((s) => s.id === id) || null),
      create: vi.fn(async ({ data, select }) => {
        const row = { id: `sched-${db.schedules.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.schedules.push(row);
        return applySelect(row, select);
      }),
      update: vi.fn(async ({ where: { id }, data, select }) => {
        const row = db.schedules.find((s) => s.id === id);
        if (row) Object.assign(row, data);
        return applySelect(row, select);
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const before = db.schedules.length;
        db.schedules = db.schedules.filter((s) => !(s.id === where.id && s.shop === where.shop));
        return { count: before - db.schedules.length };
      }),
    },
    migrationJob: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `job-${db.jobs.length + 1}`, ...data };
        db.jobs.push(row);
        return row;
      }),
    },
  },
}));

const savedSourceStore = { value: null };
vi.mock("../../app/lib/safe-db", () => ({
  getSavedSourceStore: vi.fn(async () => savedSourceStore.value),
}));

import { loader, action } from "../../app/routes/api.scheduled-sync.jsx";
// Lives in lib, not the route: a route module may only export
// loader/action/headers/middleware, or React Router bundles the rest — and
// everything it imports — into the client build.
import { startJobFromSchedule } from "../../app/lib/scheduled-sync.server.js";

function seedSchedule(overrides = {}) {
  const row = {
    id: "sched-existing",
    shop: SHOP,
    sourceShop: "source.myshopify.com",
    sourceToken: "enc-src",
    destToken: "enc-dest",
    frequency: "daily",
    hourUtc: 3,
    dayOfWeek: null,
    conflictMode: "skip",
    enabled: true,
    nextRunAt: new Date("2026-06-01T03:00:00Z"),
    lastRunAt: null,
    lastJobId: null,
    lastError: null,
    consecutiveFailures: 0,
    disabledReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  db.schedules.push(row);
  return row;
}

describe("api.scheduled-sync", () => {
  let originalEncryptionKey;

  beforeEach(() => {
    db.schedules = [];
    db.jobs = [];
    savedSourceStore.value = null;
    // encryption.server.js passes plaintext through (with a warning) when no
    // key is configured, so the at-rest assertion below is only meaningful
    // with one set.
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test-encryption-key";
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    vi.restoreAllMocks();
  });

  describe("loader", () => {
    it("lists this shop's schedules without ever returning tokens", async () => {
      seedSchedule();
      const body = await (await loader({ request: { url: "https://app.test/api/scheduled-sync" } })).json();

      expect(body.schedules).toHaveLength(1);
      // Credentials outlive the session by design — they must not leak back out.
      expect(body.schedules[0].sourceToken).toBeUndefined();
      expect(body.schedules[0].destToken).toBeUndefined();
    });

    it("scopes the list to the authenticated shop", async () => {
      seedSchedule();
      seedSchedule({ id: "other", shop: "someone-else.myshopify.com" });
      const body = await (await loader({ request: { url: "https://app.test/api/scheduled-sync" } })).json();
      expect(body.schedules).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("creates a daily schedule with an encrypted token and a future first run", async () => {
      const response = await action({
        request: mockActionRequest({ intent: "create", sourceShop: "source.myshopify.com", sourceToken: "src-token", frequency: "daily", hourUtc: "5" }),
      });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.schedule.frequency).toBe("daily");
      expect(new Date(body.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      expect(body.schedule.sourceToken).toBeUndefined();

      const stored = db.schedules[0];
      expect(stored.sourceToken).not.toBe("src-token"); // encrypted at rest
    });

    it("falls back to the saved source store when credentials aren't supplied", async () => {
      savedSourceStore.value = { sourceUrl: "saved.myshopify.com", token: "saved-token" };
      const body = await (await action({ request: mockActionRequest({ intent: "create" }) })).json();

      expect(body.ok).toBe(true);
      expect(body.schedule.sourceShop).toBe("saved.myshopify.com");
    });

    it("400s when no source credentials can be resolved", async () => {
      const response = await action({ request: mockActionRequest({ intent: "create" }) });
      expect(response.status).toBe(400);
    });

    it("rejects an unsupported frequency", async () => {
      const response = await action({
        request: mockActionRequest({ intent: "create", sourceShop: "s.myshopify.com", sourceToken: "t", frequency: "fortnightly" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/Unsupported frequency/);
    });

    it("rejects an out-of-range hourUtc", async () => {
      const response = await action({
        request: mockActionRequest({ intent: "create", sourceShop: "s.myshopify.com", sourceToken: "t", hourUtc: "27" }),
      });
      expect(response.status).toBe(400);
    });

    it("rejects an out-of-range dayOfWeek for a weekly schedule", async () => {
      const response = await action({
        request: mockActionRequest({ intent: "create", sourceShop: "s.myshopify.com", sourceToken: "t", frequency: "weekly", dayOfWeek: "9" }),
      });
      expect(response.status).toBe(400);
    });

    it("normalizes a bare shop name", async () => {
      const body = await (await action({
        request: mockActionRequest({ intent: "create", sourceShop: "source", sourceToken: "t" }),
      })).json();
      expect(body.schedule.sourceShop).toBe("source.myshopify.com");
    });
  });

  describe("update", () => {
    it("disables a schedule", async () => {
      seedSchedule();
      const body = await (await action({ request: mockActionRequest({ intent: "update", id: "sched-existing", enabled: "false" }) })).json();
      expect(body.schedule.enabled).toBe(false);
    });

    it("clears the failure streak and disable reason when re-enabled, so it doesn't immediately re-disable", async () => {
      seedSchedule({ enabled: false, consecutiveFailures: 3, disabledReason: "Disabled after 3 consecutive failures", lastError: "401" });

      const body = await (await action({ request: mockActionRequest({ intent: "update", id: "sched-existing", enabled: "true" }) })).json();

      expect(body.schedule.enabled).toBe(true);
      expect(body.schedule.consecutiveFailures).toBe(0);
      expect(body.schedule.disabledReason).toBeNull();
      // Refreshes the stored destination token from the live session, since
      // an expired credential is the usual reason it was disabled.
      expect(db.schedules[0].destToken).toBeTruthy();
    });

    it("recomputes the next run when the cadence changes", async () => {
      const seeded = seedSchedule();
      const original = seeded.nextRunAt;
      const body = await (await action({ request: mockActionRequest({ intent: "update", id: "sched-existing", frequency: "hourly" }) })).json();

      expect(body.schedule.frequency).toBe("hourly");
      expect(new Date(body.schedule.nextRunAt).getTime()).not.toBe(new Date(original).getTime());
    });

    it("404s for another shop's schedule", async () => {
      seedSchedule({ id: "theirs", shop: "someone-else.myshopify.com" });
      const response = await action({ request: mockActionRequest({ intent: "update", id: "theirs", enabled: "false" }) });
      expect(response.status).toBe(404);
      expect(db.schedules[0].enabled).toBe(true); // untouched
    });

    it("rejects an invalid frequency on update", async () => {
      seedSchedule();
      const response = await action({ request: mockActionRequest({ intent: "update", id: "sched-existing", frequency: "nope" }) });
      expect(response.status).toBe(400);
    });
  });

  describe("delete", () => {
    it("deletes this shop's schedule", async () => {
      seedSchedule();
      const body = await (await action({ request: mockActionRequest({ intent: "delete", id: "sched-existing" }) })).json();
      expect(body.ok).toBe(true);
      expect(db.schedules).toHaveLength(0);
    });

    it("404s for another shop's schedule and leaves it in place", async () => {
      seedSchedule({ id: "theirs", shop: "someone-else.myshopify.com" });
      const response = await action({ request: mockActionRequest({ intent: "delete", id: "theirs" }) });
      expect(response.status).toBe(404);
      expect(db.schedules).toHaveLength(1);
    });
  });

  describe("startJobFromSchedule", () => {
    it("creates a PENDING MigrationJob carrying the schedule's store pair and conflict mode", async () => {
      const seeded = seedSchedule({ conflictMode: "overwrite" });
      const jobId = await startJobFromSchedule(seeded);

      expect(jobId).toBe("job-1");
      expect(db.jobs[0]).toMatchObject({
        shop: SHOP, sourceShop: "source.myshopify.com", conflictMode: "overwrite", status: "PENDING",
      });
    });
  });

  it("rejects non-POST on the action", async () => {
    const response = await action({ request: { method: "GET", formData: async () => new FormData() } });
    expect(response.status).toBe(405);
  });

  it("400s on an unknown intent", async () => {
    const response = await action({ request: mockActionRequest({ intent: "bogus" }) });
    expect(response.status).toBe(400);
  });
});
