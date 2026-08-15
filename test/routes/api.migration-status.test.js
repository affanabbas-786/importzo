// Regression tests for the cross-tenant leak in GET /api/migration-status/:jobId.
//
// The route authenticated the caller but never checked that the job belonged
// to them. jobId is a caller-supplied path parameter, so any installed shop
// could read any other shop's migration — product titles, the source store
// domain, the per-record error log (which carries metafield payload
// snapshots) and the triggering user's email and IP — and could restart
// another shop's transfer through the auto-resume branch.

import { describe, it, expect, vi, beforeEach } from "vitest";

const OWNER_SHOP = "owner-shop.myshopify.com";
const ATTACKER_SHOP = "attacker-shop.myshopify.com";

const db = { job: null };
let currentShop = OWNER_SHOP;

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: currentShop, accessToken: "tok" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    migrationJob: {
      findUnique: vi.fn(async ({ where: { id } }) => (db.job && db.job.id === id ? db.job : null)),
    },
  },
}));

const runMigrationWorkerMock = vi.fn(async () => {});
const isWorkerActiveMock = vi.fn(() => false);
vi.mock("../../app/lib/migration-worker.server", () => ({
  runMigrationWorker: (...args) => runMigrationWorkerMock(...args),
  isWorkerActive: (...args) => isWorkerActiveMock(...args),
}));

vi.mock("../../app/lib/transfer-log.server", () => ({
  fetchJobLog: vi.fn(async () => []),
  fetchJobLogSummary: vi.fn(async () => ({})),
}));

const { loader } = await import("../../app/routes/api.migration-status.$jobId.jsx");

function seedJob(overrides = {}) {
  db.job = {
    id: "job-1",
    shop: OWNER_SHOP,
    status: "COMPLETED",
    totalProducts: 10,
    processedProducts: 10,
    failedProducts: 0,
    lastCursor: null,
    errorLog: JSON.stringify([{ sourceId: "1", title: "Secret Product", error: "boom" }]),
    conflictMode: "skip",
    createdAt: new Date(),
    updatedAt: new Date(),
    actorType: "user",
    actorId: "42",
    actorEmail: "owner@example.com",
    actorIp: "203.0.113.7",
    ...overrides,
  };
  return db.job;
}

function request() {
  return new Request("https://importzo.dazzletech.co/api/migration-status/job-1");
}

describe("GET /api/migration-status/:jobId", () => {
  beforeEach(() => {
    currentShop = OWNER_SHOP;
    db.job = null;
    runMigrationWorkerMock.mockReset().mockResolvedValue(undefined);
    isWorkerActiveMock.mockReset().mockReturnValue(false);
  });

  it("returns the job to the shop that owns it", async () => {
    seedJob();
    const res = await loader({ request: request(), params: { jobId: "job-1" } });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.jobId).toBe("job-1");
    expect(body.processedProducts).toBe(10);
  });

  it("does not disclose another shop's job", async () => {
    seedJob();
    currentShop = ATTACKER_SHOP;

    const res = await loader({ request: request(), params: { jobId: "job-1" } });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    // Nothing about the real job may leak through the refusal.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Secret Product");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain(OWNER_SHOP);
  });

  it("is indistinguishable from a job that does not exist, so ids stay unenumerable", async () => {
    seedJob();
    currentShop = ATTACKER_SHOP;
    const denied = await loader({ request: request(), params: { jobId: "job-1" } });

    db.job = null;
    const missing = await loader({ request: request(), params: { jobId: "job-1" } });

    expect(denied.status).toBe(missing.status);
    expect(await denied.json()).toEqual(await missing.json());
  });

  it("does not let a non-owner restart another shop's transfer via auto-resume", async () => {
    seedJob({ status: "RUNNING" });
    currentShop = ATTACKER_SHOP;

    await loader({ request: request(), params: { jobId: "job-1" } });

    expect(runMigrationWorkerMock).not.toHaveBeenCalled();
  });

  it("still auto-resumes for the owning shop after a process restart", async () => {
    seedJob({ status: "RUNNING" });

    await loader({ request: request(), params: { jobId: "job-1" } });

    expect(runMigrationWorkerMock).toHaveBeenCalledWith("job-1");
  });

  it("400s when no jobId is supplied", async () => {
    const res = await loader({ request: request(), params: {} });
    expect(res.status).toBe(400);
  });
});
