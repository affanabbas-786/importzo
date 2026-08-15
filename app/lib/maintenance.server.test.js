import { describe, it, expect, vi } from "vitest";
import { runMaintenance, purgeExpiredTransferSessions } from "./maintenance.server.js";

function fakePrisma({ backupsDeleted = 0, sessionsDeleted = 0, backupThrows = null, sessionThrows = null } = {}) {
  return {
    storeBackup: {
      deleteMany: vi.fn(async () => {
        if (backupThrows) throw new Error(backupThrows);
        return { count: backupsDeleted };
      }),
    },
    transferSession: {
      deleteMany: vi.fn(async () => {
        if (sessionThrows) throw new Error(sessionThrows);
        return { count: sessionsDeleted };
      }),
    },
  };
}

describe("purgeExpiredTransferSessions", () => {
  it("deletes only rows whose expiry has passed", async () => {
    const prisma = fakePrisma({ sessionsDeleted: 4 });
    const now = new Date("2026-08-13T10:00:00Z");

    const result = await purgeExpiredTransferSessions(prisma, now);

    expect(result.deleted).toBe(4);
    expect(prisma.transferSession.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: now } },
    });
  });

  it("does not care about status — an 'active' row past its expiry is still a live source-store token", async () => {
    const prisma = fakePrisma({ sessionsDeleted: 1 });
    await purgeExpiredTransferSessions(prisma, new Date());

    const where = prisma.transferSession.deleteMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("status");
  });

  it("no-ops when the model is unavailable rather than throwing", async () => {
    await expect(purgeExpiredTransferSessions({})).resolves.toEqual({ deleted: 0 });
  });
});

describe("runMaintenance", () => {
  it("runs both purges and reports the counts", async () => {
    const prisma = fakePrisma({ backupsDeleted: 2, sessionsDeleted: 3 });

    const result = await runMaintenance({ prisma });

    expect(result.backupsPurged).toBe(2);
    expect(result.transferSessionsPurged).toBe(3);
  });

  it("isolates a failing purge so the other still runs", async () => {
    const prisma = fakePrisma({ backupThrows: "table is locked", sessionsDeleted: 5 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runMaintenance({ prisma });

    expect(result.backupsPurged).toBe(0);
    expect(result.backupPurgeError).toMatch(/table is locked/);
    expect(result.transferSessionsPurged).toBe(5);
    vi.restoreAllMocks();
  });

  it("never throws — housekeeping must not fail a scheduler tick", async () => {
    const prisma = fakePrisma({ backupThrows: "boom", sessionThrows: "bang" });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runMaintenance({ prisma })).resolves.toMatchObject({
      backupsPurged: 0,
      transferSessionsPurged: 0,
    });
    vi.restoreAllMocks();
  });
});
