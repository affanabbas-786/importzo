import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ACTION, ENTITY, truncate, normalizeEntry, createLogBuffer,
  summarizeLog, fetchJobLog, fetchJobLogSummary,
} from "./transfer-log.server.js";

function fakePrisma({ createManyImpl } = {}) {
  return {
    transferLogEntry: {
      createMany: vi.fn(createManyImpl || (async ({ data }) => ({ count: data.length }))),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  };
}

describe("truncate", () => {
  it("returns null for null/undefined", () => {
    expect(truncate(null, 10)).toBeNull();
    expect(truncate(undefined, 10)).toBeNull();
  });

  it("leaves short strings untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long strings with an ellipsis, never exceeding max", () => {
    const result = truncate("x".repeat(50), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("…")).toBe(true);
  });

  it("JSON-stringifies non-strings", () => {
    expect(truncate({ a: 1 }, 100)).toBe('{"a":1}');
  });
});

describe("normalizeEntry", () => {
  const base = { jobId: "job-1", shop: "s.myshopify.com", entityType: ENTITY.PRODUCT, action: ACTION.CREATED };

  it("produces exactly the table's columns", () => {
    const result = normalizeEntry({ ...base, sourceId: 1, destId: 2, title: "Tee" });
    expect(Object.keys(result).sort()).toEqual(
      [
        "action", "destId", "detail", "entityType", "jobId", "reason", "shop", "sourceId", "title",
        // Phase 3.7 audit trail
        "actorType", "actorId", "actorEmail", "actorIp",
      ].sort(),
    );
  });

  it("coerces numeric ids to strings", () => {
    const result = normalizeEntry({ ...base, sourceId: 123, destId: 456 });
    expect(result.sourceId).toBe("123");
    expect(result.destId).toBe("456");
  });

  it("nulls out absent ids rather than emitting undefined", () => {
    const result = normalizeEntry(base);
    expect(result.sourceId).toBeNull();
    expect(result.destId).toBeNull();
  });

  it("throws on a missing jobId", () => {
    expect(() => normalizeEntry({ ...base, jobId: undefined })).toThrow(/jobId is required/);
  });

  it("throws on a missing entityType", () => {
    expect(() => normalizeEntry({ ...base, entityType: undefined })).toThrow(/entityType is required/);
  });

  it("throws on an unknown action, so typos surface instead of silently storing junk", () => {
    expect(() => normalizeEntry({ ...base, action: "creted" })).toThrow(/unknown action/);
  });

  it("truncates an oversized detail payload", () => {
    const result = normalizeEntry({ ...base, detail: "y".repeat(5000) });
    expect(result.detail.length).toBeLessThanOrEqual(1000);
  });
});

describe("createLogBuffer", () => {
  let prisma;

  beforeEach(() => {
    prisma = fakePrisma();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("buffers entries and does not write until flushEvery is reached", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 3 });
    await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED });
    await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED });

    expect(prisma.transferLogEntry.createMany).not.toHaveBeenCalled();
    expect(buf.pendingCount()).toBe(2);
  });

  it("auto-flushes once flushEvery is reached", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 3 });
    for (let i = 0; i < 3; i++) await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED });

    expect(prisma.transferLogEntry.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.transferLogEntry.createMany.mock.calls[0][0].data).toHaveLength(3);
    expect(buf.pendingCount()).toBe(0);
    expect(buf.writtenCount()).toBe(3);
  });

  it("flush() writes whatever remains and is a no-op when empty", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 100 });
    await buf.add({ entityType: ENTITY.PAGE, action: ACTION.UPDATED });

    expect(await buf.flush()).toBe(1);
    expect(await buf.flush()).toBe(0); // nothing pending — no second write
    expect(prisma.transferLogEntry.createMany).toHaveBeenCalledTimes(1);
  });

  it("batches a large run instead of writing one row at a time", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 50 });
    for (let i = 0; i < 500; i++) await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED, sourceId: i });
    await buf.flush();

    // 500 entries / 50 per batch = 10 writes, not 500.
    expect(prisma.transferLogEntry.createMany).toHaveBeenCalledTimes(10);
    expect(buf.writtenCount()).toBe(500);
  });

  it("never throws when the DB write fails — logging must not abort a transfer", async () => {
    prisma = fakePrisma({ createManyImpl: async () => { throw new Error("database is locked"); } });
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 1 });

    await expect(buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED })).resolves.toBeUndefined();
    expect(buf.getLastError().message).toMatch(/database is locked/);
    expect(buf.writtenCount()).toBe(0);
  });

  it("drops a malformed entry instead of throwing into the transfer loop", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 1 });
    await expect(buf.add({ entityType: ENTITY.PRODUCT, action: "bogus" })).resolves.toBeUndefined();

    expect(prisma.transferLogEntry.createMany).not.toHaveBeenCalled();
    expect(buf.getLastError().message).toMatch(/unknown action/);
  });

  // ── Phase 3.7 audit trail ──
  it("stamps the buffer's actor onto every entry", async () => {
    const actor = { actorType: "user", actorId: "42", actorEmail: "a@b.com", actorIp: "203.0.113.7" };
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 1, actor });
    await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED });

    expect(prisma.transferLogEntry.createMany.mock.calls[0][0].data[0]).toMatchObject(actor);
  });

  it("records an honest 'unknown' actor rather than guessing when none is supplied", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-1", shop: "s", flushEvery: 1 });
    await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED });

    const row = prisma.transferLogEntry.createMany.mock.calls[0][0].data[0];
    expect(row.actorType).toBe("unknown");
    expect(row.actorId).toBeNull();
    expect(row.actorEmail).toBeNull();
    expect(row.actorIp).toBeNull();
  });

  it("lets an individual entry override the buffer's actor", async () => {
    const buf = createLogBuffer({
      prisma, jobId: "job-1", shop: "s", flushEvery: 1,
      actor: { actorType: "user", actorEmail: "a@b.com" },
    });
    await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED, actorType: "system", actorEmail: null });

    const row = prisma.transferLogEntry.createMany.mock.calls[0][0].data[0];
    expect(row.actorType).toBe("system");
    expect(row.actorEmail).toBeNull();
  });

  it("stamps every entry with the buffer's jobId and shop", async () => {
    const buf = createLogBuffer({ prisma, jobId: "job-42", shop: "dest.myshopify.com", flushEvery: 1 });
    await buf.add({ entityType: ENTITY.PRODUCT, action: ACTION.CREATED, sourceId: "1" });

    expect(prisma.transferLogEntry.createMany.mock.calls[0][0].data[0]).toMatchObject({
      jobId: "job-42", shop: "dest.myshopify.com",
    });
  });
});

describe("summarizeLog", () => {
  it("counts by action", () => {
    const summary = summarizeLog([
      { action: ACTION.CREATED }, { action: ACTION.CREATED },
      { action: ACTION.SKIPPED }, { action: ACTION.FAILED }, { action: ACTION.UPDATED },
    ]);
    expect(summary).toEqual({ created: 2, updated: 1, skipped: 1, failed: 1, total: 5 });
  });

  it("returns an all-zero summary for an empty log", () => {
    expect(summarizeLog([])).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0, total: 0 });
  });

  it("counts unknown actions toward total without inventing a bucket", () => {
    const summary = summarizeLog([{ action: "weird" }]);
    expect(summary.total).toBe(1);
    expect(summary).not.toHaveProperty("weird");
  });
});

describe("fetchJobLog", () => {
  it("filters by job and orders newest first", async () => {
    const prisma = fakePrisma();
    await fetchJobLog(prisma, "job-1");
    expect(prisma.transferLogEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { jobId: "job-1" },
      orderBy: { createdAt: "desc" },
    }));
  });

  it("applies action and entityType filters when given", async () => {
    const prisma = fakePrisma();
    await fetchJobLog(prisma, "job-1", { action: ACTION.FAILED, entityType: ENTITY.PRODUCT });
    expect(prisma.transferLogEntry.findMany.mock.calls[0][0].where).toEqual({
      jobId: "job-1", action: "failed", entityType: "product",
    });
  });

  it("clamps limit to a sane maximum so the UI can't request the whole table", async () => {
    const prisma = fakePrisma();
    await fetchJobLog(prisma, "job-1", { limit: 99999 });
    expect(prisma.transferLogEntry.findMany.mock.calls[0][0].take).toBe(500);
  });

  it("clamps a negative offset to zero", async () => {
    const prisma = fakePrisma();
    await fetchJobLog(prisma, "job-1", { offset: -10 });
    expect(prisma.transferLogEntry.findMany.mock.calls[0][0].skip).toBe(0);
  });
});

describe("fetchJobLogSummary", () => {
  it("aggregates counts in the DB rather than loading rows", async () => {
    const prisma = fakePrisma();
    prisma.transferLogEntry.groupBy = vi.fn(async () => [
      { action: "created", _count: { _all: 12 } },
      { action: "skipped", _count: { _all: 3 } },
      { action: "failed", _count: { _all: 1 } },
    ]);

    const summary = await fetchJobLogSummary(prisma, "job-1");
    expect(summary).toEqual({ created: 12, updated: 0, skipped: 3, failed: 1, total: 16 });
    expect(prisma.transferLogEntry.findMany).not.toHaveBeenCalled();
  });

  it("returns zeros for a job with no log entries", async () => {
    const prisma = fakePrisma();
    expect(await fetchJobLogSummary(prisma, "job-none")).toEqual({
      created: 0, updated: 0, skipped: 0, failed: 0, total: 0,
    });
  });
});
