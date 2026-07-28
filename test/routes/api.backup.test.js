import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

const db = { backups: [] };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    storeBackup: {
      // Honors `select` so a test asserting the snapshot payload is withheld
      // is testing the route's projection, not this fake's laziness.
      findMany: vi.fn(async ({ where, select }) => {
        const rows = db.backups.filter((b) => b.shop === where.shop && (!where.jobId || b.jobId === where.jobId));
        if (!select) return rows;
        return rows.map((row) => Object.fromEntries(
          Object.entries(select).filter(([, wanted]) => wanted).map(([key]) => [key, row[key]]),
        ));
      }),
      findUnique: vi.fn(async ({ where: { id } }) => db.backups.find((b) => b.id === id) || null),
      create: vi.fn(async ({ data }) => {
        const row = { id: `backup-${db.backups.length + 1}`, ...data };
        db.backups.push(row);
        return row;
      }),
      update: vi.fn(async ({ where: { id }, data }) => {
        const row = db.backups.find((b) => b.id === id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  },
}));

import { loader, action } from "../../app/routes/api.backup.jsx";
// The route uses the real limiter (module-level state), so it must be reset
// between tests or counts leak across cases.
import { __resetRateLimitState, POLICIES } from "../../app/lib/rate-limit.server.js";

const SNAPSHOT = {
  version: 1,
  capturedAt: new Date().toISOString(),
  shop: "dest-shop.myshopify.com",
  products: [{ id: "gid://shopify/Product/1", handle: "p-1", title: "Original", descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE" }],
  collections: [],
  truncated: { products: false, collections: false },
  counts: { products: 1, collections: 0, metafields: 0 },
};

function seedBackup(overrides = {}) {
  const row = {
    id: "backup-seed",
    shop: "dest-shop.myshopify.com",
    jobId: null,
    status: "READY",
    truncated: false,
    productCount: 1,
    collectionCount: 0,
    metafieldCount: 0,
    sizeBytes: 100,
    error: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    restoredAt: null,
    data: JSON.stringify(SNAPSHOT),
    ...overrides,
  };
  db.backups.push(row);
  return row;
}

describe("api.backup", () => {
  beforeEach(() => {
    db.backups = [];
    global.fetch = vi.fn();
    __resetRateLimitState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loader (list)", () => {
    it("returns this shop's backups without the snapshot payload", async () => {
      seedBackup();
      const response = await loader({ request: { url: "https://app.test/api/backup" } });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.backups).toHaveLength(1);
      // `data` holds the entire snapshot — a list view must never ship it.
      expect(body.backups[0].data).toBeUndefined();
    });

    it("scopes the list to the authenticated shop", async () => {
      seedBackup();
      seedBackup({ id: "other", shop: "someone-else.myshopify.com" });
      const response = await loader({ request: { url: "https://app.test/api/backup" } });
      const body = await response.json();

      expect(body.backups.map((b) => b.id)).toEqual(["backup-seed"]);
    });
  });

  describe("action intent=create", () => {
    it("takes an on-demand snapshot", async () => {
      global.fetch = vi.fn(async (url, opts) => {
        const query = JSON.parse(opts.body).query || "";
        if (query.includes("BackupProducts")) {
          return jsonResponse({ data: { products: { edges: [{ cursor: "0", node: { id: "gid://shopify/Product/1", handle: "p", title: "T", descriptionHtml: "", vendor: "", productType: "", tags: [], status: "ACTIVE", metafields: { edges: [] } } }], pageInfo: { hasNextPage: false } } } });
        }
        return jsonResponse({ data: { collections: { edges: [], pageInfo: { hasNextPage: false } } } });
      });

      const response = await action({ request: mockActionRequest({ intent: "create" }) });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.status).toBe("READY");
      expect(body.productCount).toBe(1);
    });

    it("returns 502 when the snapshot cannot be taken", async () => {
      global.fetch = vi.fn(async () => jsonResponse({}, { status: 403 }));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await action({ request: mockActionRequest({ intent: "create" }) });
      expect(response.status).toBe(502);
      expect((await response.json()).ok).toBe(false);
    });
  });

  describe("action intent=restore", () => {
    it("restores a backup belonging to this shop", async () => {
      seedBackup();
      global.fetch = vi.fn(async () => jsonResponse({ data: { productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } } }));

      const response = await action({ request: mockActionRequest({ intent: "restore", backupId: "backup-seed" }) });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.restored).toBe(1);
    });

    it("refuses to restore another shop's backup, and does not reveal that it exists", async () => {
      seedBackup({ id: "someone-elses", shop: "someone-else.myshopify.com" });

      const response = await action({ request: mockActionRequest({ intent: "restore", backupId: "someone-elses" }) });
      const body = await response.json();

      expect(response.status).toBe(404);
      // Same wording as a genuinely missing id — no existence oracle.
      expect(body.error).toBe("Backup not found");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("404s for a backup id that doesn't exist", async () => {
      const response = await action({ request: mockActionRequest({ intent: "restore", backupId: "nope" }) });
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("Backup not found");
    });

    it("400s when backupId is missing", async () => {
      const response = await action({ request: mockActionRequest({ intent: "restore" }) });
      expect(response.status).toBe(400);
    });

    it("reports a failed restore with per-record errors", async () => {
      seedBackup();
      global.fetch = vi.fn(async () => jsonResponse({ data: { productUpdate: { product: null, userErrors: [{ message: "Product does not exist" }] } } }));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const response = await action({ request: mockActionRequest({ intent: "restore", backupId: "backup-seed" }) });
      const body = await response.json();

      expect(body.ok).toBe(false);
      expect(body.failed).toBe(1);
      expect(body.errors[0].error).toMatch(/does not exist/);
    });

    it("refuses to restore an expired backup", async () => {
      seedBackup({ expiresAt: new Date(Date.now() - 1000) });
      const response = await action({ request: mockActionRequest({ intent: "restore", backupId: "backup-seed" }) });
      const body = await response.json();

      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/expired/i);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // Phase 3: proves the limiter is actually wired into this route, not just
  // unit-tested in isolation.
  describe("rate limiting", () => {
    function okSnapshotFetch() {
      return vi.fn(async (url, opts) => {
        const query = JSON.parse(opts.body).query || "";
        if (query.includes("BackupProducts")) {
          return jsonResponse({ data: { products: { edges: [], pageInfo: { hasNextPage: false } } } });
        }
        return jsonResponse({ data: { collections: { edges: [], pageInfo: { hasNextPage: false } } } });
      });
    }

    it("429s once the hourly backup limit is exhausted", async () => {
      global.fetch = okSnapshotFetch();
      for (let i = 0; i < POLICIES.backup.limit; i++) {
        const res = await action({ request: mockActionRequest({ intent: "create" }) });
        expect(res.status).toBe(200);
      }

      const blocked = await action({ request: mockActionRequest({ intent: "create" }) });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBeTruthy();
      expect((await blocked.json()).error).toMatch(/rate limit/i);
    });

    it("releases the concurrency slot after a request, so sequential calls still work", async () => {
      global.fetch = okSnapshotFetch();
      const first = await action({ request: mockActionRequest({ intent: "create" }) });
      const second = await action({ request: mockActionRequest({ intent: "create" }) });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("releases the slot even when the snapshot fails, so a failure can't wedge the shop", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      global.fetch = vi.fn(async () => jsonResponse({}, { status: 403 }));
      const failed = await action({ request: mockActionRequest({ intent: "create" }) });
      expect(failed.status).toBe(502);

      // A subsequent request must not be blocked by a leaked slot.
      global.fetch = okSnapshotFetch();
      const next = await action({ request: mockActionRequest({ intent: "create" }) });
      expect(next.status).toBe(200);
    });
  });

  it("rejects non-POST methods on the action", async () => {
    const response = await action({ request: { method: "GET", formData: async () => new FormData() } });
    expect(response.status).toBe(405);
  });

  it("400s on an unknown intent", async () => {
    const response = await action({ request: mockActionRequest({ intent: "bogus" }) });
    expect(response.status).toBe(400);
  });
});
