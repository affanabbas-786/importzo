import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_ROLLBACK_WINDOW_HOURS, DELETABLE_ACTION,
  rollbackDeadline, isWithinRollbackWindow, checkRollbackEligibility,
  planRollback, getRollbackPlan, rollbackJob,
} from "./rollback.server.js";

const SHOP = "dest-shop.myshopify.com";

function job(overrides = {}) {
  return {
    id: "job-1",
    shop: SHOP,
    status: "COMPLETED",
    rolledBackAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function mapping(sourceProductId, action, overrides = {}) {
  return {
    id: `m-${sourceProductId}`,
    jobId: "job-1",
    sourceProductId,
    destProductId: `dest-${sourceProductId}`,
    status: "DONE",
    error: null,
    action,
    ...overrides,
  };
}

function fakePrisma({ jobRow = job(), mappings = [] } = {}) {
  return {
    migrationJob: {
      findUnique: vi.fn(async () => jobRow),
      update: vi.fn(async ({ data }) => Object.assign(jobRow, data)),
    },
    productMapping: {
      findMany: vi.fn(async () => mappings),
    },
    __job: () => jobRow,
  };
}

function deleteOk() {
  return vi.fn(async (shop, token, query, variables) => ({
    productDelete: { deletedProductId: variables.input.id, userErrors: [] },
  }));
}

describe("rollback window", () => {
  it("computes the deadline from when the job last ran", () => {
    const deadline = rollbackDeadline(job(), 24);
    expect(deadline.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("is inside the window before the deadline and outside after", () => {
    expect(isWithinRollbackWindow(job(), new Date("2026-01-01T23:59:00Z"), 24)).toBe(true);
    expect(isWithinRollbackWindow(job(), new Date("2026-01-02T00:00:01Z"), 24)).toBe(false);
  });

  it("treats a job with no timestamps as outside the window rather than defaulting open", () => {
    expect(isWithinRollbackWindow({ id: "x" }, new Date(), 24)).toBe(false);
  });

  it("has a sane default window", () => {
    expect(DEFAULT_ROLLBACK_WINDOW_HOURS).toBe(24);
  });
});

describe("checkRollbackEligibility", () => {
  const now = new Date("2026-01-01T01:00:00Z");

  it("allows a completed job inside the window", () => {
    expect(checkRollbackEligibility(job(), { now, shop: SHOP })).toMatchObject({ eligible: true, blockers: [] });
  });

  it("blocks a job that was already rolled back", () => {
    const result = checkRollbackEligibility(job({ rolledBackAt: new Date() }), { now, shop: SHOP });
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]).toMatch(/already been rolled back/i);
  });

  it("blocks a job that is still running", () => {
    const result = checkRollbackEligibility(job({ status: "RUNNING" }), { now, shop: SHOP });
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => /still running/i.test(b))).toBe(true);
  });

  it("blocks once the window has closed, naming the deadline", () => {
    const result = checkRollbackEligibility(job(), { now: new Date("2026-01-03T00:00:00Z"), shop: SHOP });
    expect(result.eligible).toBe(false);
    expect(result.blockers.some((b) => /rollback window closed/i.test(b))).toBe(true);
  });

  it("reports every blocker at once rather than one at a time", () => {
    const result = checkRollbackEligibility(job({ rolledBackAt: new Date(), status: "RUNNING" }), {
      now: new Date("2026-01-03T00:00:00Z"), shop: SHOP,
    });
    expect(result.blockers.length).toBeGreaterThanOrEqual(3);
  });

  it("hides another shop's job behind the same message as a missing one", () => {
    const result = checkRollbackEligibility(job(), { now, shop: "someone-else.myshopify.com" });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual(["Job not found"]);
  });

  it("blocks a missing job", () => {
    expect(checkRollbackEligibility(null, { now, shop: SHOP })).toMatchObject({ eligible: false });
  });
});

// ── The safety core: what rollback is and isn't allowed to delete ──
describe("planRollback — deletion safety rules", () => {
  it("deletes only products this transfer created", () => {
    const plan = planRollback([mapping("1", "created"), mapping("2", "created")]);
    expect(plan.summary.willDelete).toBe(2);
    expect(plan.summary.willPreserve).toBe(0);
  });

  it("NEVER deletes a skipped product — that is the merchant's own pre-existing data", () => {
    const plan = planRollback([mapping("1", "skipped")]);
    expect(plan.summary.willDelete).toBe(0);
    expect(plan.deletable).toEqual([]);
    expect(plan.preserved[0].reason).toMatch(/pre-existing product/i);
  });

  it("NEVER deletes an overwritten product — restore reverts it, deletion would destroy it", () => {
    const plan = planRollback([mapping("1", "updated")]);
    expect(plan.summary.willDelete).toBe(0);
    expect(plan.preserved[0].reason).toMatch(/restore the pre-transfer backup/i);
  });

  it("NEVER deletes a legacy row whose action is unknown", () => {
    // Rows written before ProductMapping.action existed default to "unknown".
    const plan = planRollback([mapping("1", "unknown")]);
    expect(plan.summary.willDelete).toBe(0);
    expect(plan.preserved[0].reason).toMatch(/cannot prove it created/i);
  });

  it("treats a missing action the same as unknown rather than assuming it was created", () => {
    const plan = planRollback([{ ...mapping("1", undefined), action: undefined }]);
    expect(plan.summary.willDelete).toBe(0);
  });

  it("skips FAILED mappings and ones with no destination product", () => {
    const plan = planRollback([
      mapping("1", "created", { status: "FAILED" }),
      mapping("2", "created", { destProductId: null }),
    ]);
    expect(plan.summary.willDelete).toBe(0);
    expect(plan.preserved).toHaveLength(2);
  });

  it("separates a mixed job correctly", () => {
    const plan = planRollback([
      mapping("1", "created"),
      mapping("2", "skipped"),
      mapping("3", "updated"),
      mapping("4", "created"),
      mapping("5", "unknown"),
    ]);
    expect(plan.summary).toEqual({ willDelete: 2, willPreserve: 3, total: 5 });
    expect(plan.deletable.map((m) => m.sourceProductId)).toEqual(["1", "4"]);
  });

  it("only ever treats 'created' as deletable", () => {
    expect(DELETABLE_ACTION).toBe("created");
  });
});

describe("getRollbackPlan", () => {
  it("returns eligibility alongside the plan, without deleting anything", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created"), mapping("2", "skipped")] });
    const result = await getRollbackPlan(prisma, "job-1", { now: new Date("2026-01-01T01:00:00Z"), shop: SHOP });

    expect(result.eligible).toBe(true);
    expect(result.plan.summary).toEqual({ willDelete: 1, willPreserve: 1, total: 2 });
  });

  it("returns a null plan for a missing job", async () => {
    const prisma = fakePrisma({ jobRow: null });
    const result = await getRollbackPlan(prisma, "nope", { shop: SHOP });
    expect(result.plan).toBeNull();
    expect(result.eligible).toBe(false);
  });
});

describe("rollbackJob", () => {
  const now = () => new Date("2026-01-01T01:00:00Z");

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("deletes created products and reports the count", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created"), mapping("2", "created")] });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(2);
    expect(shopifyGraphql).toHaveBeenCalledTimes(2);
  });

  it("issues productDelete with the correct GID built from the destination id", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created")] });
    const shopifyGraphql = deleteOk();

    await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    const [, , query, variables] = shopifyGraphql.mock.calls[0];
    expect(query).toMatch(/\$input: ProductDeleteInput!/);
    expect(variables.input.id).toBe("gid://shopify/Product/dest-1");
  });

  it("does NOT delete skipped/updated/unknown products even when they are in the job", async () => {
    const prisma = fakePrisma({
      mappings: [mapping("1", "created"), mapping("2", "skipped"), mapping("3", "updated"), mapping("4", "unknown")],
    });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.deleted).toBe(1);
    expect(result.preserved).toBe(3);
    // Exactly one delete call, and it targeted the created product only.
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
    expect(shopifyGraphql.mock.calls[0][3].input.id).toBe("gid://shopify/Product/dest-1");
  });

  it("refuses to delete anything once the window has closed", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created")] });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({
      prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10",
      now: () => new Date("2026-01-05T00:00:00Z"), shop: SHOP,
    });

    expect(result.ok).toBe(false);
    expect(result.deleted).toBe(0);
    expect(shopifyGraphql).not.toHaveBeenCalled();
    expect(result.blockers.some((b) => /window closed/i.test(b))).toBe(true);
  });

  it("refuses to roll back the same job twice", async () => {
    const prisma = fakePrisma({ jobRow: job({ rolledBackAt: new Date("2026-01-01T00:30:00Z") }), mappings: [mapping("1", "created")] });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.ok).toBe(false);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("refuses to roll back another shop's job", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created")] });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({
      prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now,
      shop: "someone-else.myshopify.com",
    });

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(["Job not found"]);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("refuses to roll back a job that is still running", async () => {
    const prisma = fakePrisma({ jobRow: job({ status: "RUNNING" }), mappings: [mapping("1", "created")] });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.ok).toBe(false);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("keeps going when one delete fails, and reports it", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created"), mapping("2", "created"), mapping("3", "created")] });
    const shopifyGraphql = vi.fn(async (shop, token, query, variables) => {
      if (variables.input.id.endsWith("dest-2")) throw new Error("network blip");
      return { productDelete: { deletedProductId: variables.input.id, userErrors: [] } };
    });

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.errors[0].destProductId).toBe("dest-2");
  });

  it("counts a userErrors response as failed, not deleted", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created")] });
    const shopifyGraphql = vi.fn(async () => ({
      productDelete: { deletedProductId: null, userErrors: [{ message: "Product does not exist" }] },
    }));

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toMatch(/does not exist/);
  });

  it("stamps rolledBackAt even on partial failure, so it can't be re-run against already-deleted products", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created"), mapping("2", "created")] });
    const shopifyGraphql = vi.fn(async (shop, token, query, variables) => {
      if (variables.input.id.endsWith("dest-2")) throw new Error("boom");
      return { productDelete: { deletedProductId: variables.input.id, userErrors: [] } };
    });

    await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(prisma.migrationJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ rolledBackAt: expect.any(Date) }),
    }));
  });

  it("writes rollback outcomes to the transfer log when a buffer is supplied", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "created")] });
    const logBuffer = { add: vi.fn(), flush: vi.fn() };

    await rollbackJob({ prisma, shopifyGraphql: deleteOk(), jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP, logBuffer });

    expect(logBuffer.add).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "product", destId: "dest-1", reason: "Deleted by rollback",
    }));
    expect(logBuffer.flush).toHaveBeenCalled();
  });

  it("handles a job with nothing deletable without erroring", async () => {
    const prisma = fakePrisma({ mappings: [mapping("1", "skipped")] });
    const shopifyGraphql = deleteOk();

    const result = await rollbackJob({ prisma, shopifyGraphql, jobId: "job-1", token: "t", version: "2025-10", now, shop: SHOP });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.preserved).toBe(1);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });
});
