import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

const db = { job: null, mappings: [], logEntries: [] };
const SHOP = "dest-shop.myshopify.com";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: SHOP, accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    migrationJob: {
      findUnique: vi.fn(async ({ where: { id } }) => (db.job && db.job.id === id ? db.job : null)),
      update: vi.fn(async ({ data }) => Object.assign(db.job, data)),
    },
    productMapping: {
      findMany: vi.fn(async ({ where: { jobId } }) => db.mappings.filter((m) => m.jobId === jobId)),
    },
    transferLogEntry: {
      createMany: vi.fn(async ({ data }) => { db.logEntries.push(...data); return { count: data.length }; }),
    },
  },
}));

import { loader, action } from "../../app/routes/api.rollback.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";

function seedJob(overrides = {}) {
  db.job = {
    id: "job-1",
    shop: SHOP,
    status: "COMPLETED",
    rolledBackAt: null,
    backupId: "backup-1",
    createdAt: new Date(),
    updatedAt: new Date(), // inside the 24h window
    ...overrides,
  };
  return db.job;
}

function seedMapping(sourceProductId, action, overrides = {}) {
  const row = {
    id: `m-${sourceProductId}`, jobId: "job-1", sourceProductId,
    destProductId: `dest-${sourceProductId}`, status: "DONE", error: null, action, ...overrides,
  };
  db.mappings.push(row);
  return row;
}

describe("api.rollback", () => {
  beforeEach(() => {
    __resetRateLimitState();
    db.job = null;
    db.mappings = [];
    db.logEntries = [];
    global.fetch = vi.fn(async (url, opts) => {
      const variables = JSON.parse(opts.body).variables;
      return jsonResponse({ data: { productDelete: { deletedProductId: variables.input.id, userErrors: [] } } });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loader (plan)", () => {
    it("reports what would be deleted vs preserved, with reasons, without deleting anything", async () => {
      seedJob();
      seedMapping("1", "created");
      seedMapping("2", "skipped");

      const response = await loader({ request: { url: "https://app.test/api/rollback?jobId=job-1" } });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.eligible).toBe(true);
      expect(body.summary).toEqual({ willDelete: 1, willPreserve: 1, total: 2 });
      expect(body.willPreserve[0].reason).toMatch(/pre-existing product/i);
      expect(global.fetch).not.toHaveBeenCalled(); // read-only
    });

    it("reports blockers for an out-of-window job", async () => {
      seedJob({ updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });
      seedMapping("1", "created");

      const body = await (await loader({ request: { url: "https://app.test/api/rollback?jobId=job-1" } })).json();

      expect(body.eligible).toBe(false);
      expect(body.blockers.some((b) => /window closed/i.test(b))).toBe(true);
    });

    it("404s for another shop's job, indistinguishably from a missing one", async () => {
      seedJob({ shop: "someone-else.myshopify.com" });
      const response = await loader({ request: { url: "https://app.test/api/rollback?jobId=job-1" } });
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("Job not found");
    });

    it("400s without a jobId", async () => {
      const response = await loader({ request: { url: "https://app.test/api/rollback" } });
      expect(response.status).toBe(400);
    });
  });

  describe("action (execute)", () => {
    it("deletes only the products the transfer created", async () => {
      seedJob();
      seedMapping("1", "created");
      seedMapping("2", "skipped");
      seedMapping("3", "updated");

      const body = await (await action({ request: mockActionRequest({ intent: "rollback", jobId: "job-1" }) })).json();

      expect(body.ok).toBe(true);
      expect(body.deleted).toBe(1);
      expect(body.preserved).toBe(2);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(global.fetch.mock.calls[0][1].body).variables.input.id).toBe("gid://shopify/Product/dest-1");
    });

    it("409s with blockers and deletes nothing when out of window", async () => {
      seedJob({ updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });
      seedMapping("1", "created");

      const response = await action({ request: mockActionRequest({ intent: "rollback", jobId: "job-1" }) });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.ok).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("409s when the job was already rolled back", async () => {
      seedJob({ rolledBackAt: new Date() });
      seedMapping("1", "created");

      const response = await action({ request: mockActionRequest({ intent: "rollback", jobId: "job-1" }) });
      expect(response.status).toBe(409);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("refuses another shop's job without deleting anything", async () => {
      seedJob({ shop: "someone-else.myshopify.com" });
      seedMapping("1", "created");

      const response = await action({ request: mockActionRequest({ intent: "rollback", jobId: "job-1" }) });
      expect(response.status).toBe(409);
      expect((await response.json()).blockers).toEqual(["Job not found"]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("reports partial failures per record", async () => {
      seedJob();
      seedMapping("1", "created");
      seedMapping("2", "created");
      global.fetch = vi.fn(async (url, opts) => {
        const variables = JSON.parse(opts.body).variables;
        if (variables.input.id.endsWith("dest-2")) {
          return jsonResponse({ data: { productDelete: { deletedProductId: null, userErrors: [{ message: "Product does not exist" }] } } });
        }
        return jsonResponse({ data: { productDelete: { deletedProductId: variables.input.id, userErrors: [] } } });
      });

      const body = await (await action({ request: mockActionRequest({ intent: "rollback", jobId: "job-1" }) })).json();

      expect(body.ok).toBe(false);
      expect(body.deleted).toBe(1);
      expect(body.failed).toBe(1);
      expect(body.errors[0].error).toMatch(/does not exist/);
    });

    it("records the rollback in the transfer log", async () => {
      seedJob();
      seedMapping("1", "created");

      await action({ request: mockActionRequest({ intent: "rollback", jobId: "job-1" }) });

      expect(db.logEntries.some((e) => e.reason === "Deleted by rollback")).toBe(true);
    });

    it("400s without a jobId", async () => {
      const response = await action({ request: mockActionRequest({ intent: "rollback" }) });
      expect(response.status).toBe(400);
    });

    it("400s on an unknown intent", async () => {
      const response = await action({ request: mockActionRequest({ intent: "bogus", jobId: "job-1" }) });
      expect(response.status).toBe(400);
    });

    it("rejects non-POST", async () => {
      const response = await action({ request: { method: "GET", formData: async () => new FormData() } });
      expect(response.status).toBe(405);
    });
  });
});
