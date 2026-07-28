import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  snapshotStore, createBackup, restoreBackup, parseSnapshot, isExpired,
  computeExpiry, purgeExpiredBackups, SNAPSHOT_VERSION,
  MAX_SNAPSHOT_PRODUCTS, MAX_SNAPSHOT_COLLECTIONS,
} from "./backup.server.js";

function productNode(i, { metafields = [] } = {}) {
  return {
    id: `gid://shopify/Product/${i}`,
    handle: `product-${i}`,
    title: `Product ${i}`,
    descriptionHtml: `<p>${i}</p>`,
    vendor: "Acme",
    productType: "Widget",
    tags: ["a"],
    status: "ACTIVE",
    metafields: { edges: metafields.map((node) => ({ node })) },
  };
}

function collectionNode(i) {
  return {
    id: `gid://shopify/Collection/${i}`,
    handle: `collection-${i}`,
    title: `Collection ${i}`,
    descriptionHtml: "",
    sortOrder: "MANUAL",
    metafields: { edges: [] },
  };
}

// Serves paginated products/collections to snapshotStore.
function makeGraphql({ products = [], collections = [], pageSize = 100, onCall } = {}) {
  return vi.fn(async (shop, token, query, variables) => {
    onCall?.(query, variables);
    const isProducts = query.includes("BackupProducts");
    const source = isProducts ? products : collections;
    const field = isProducts ? "products" : "collections";

    const after = variables?.after;
    const start = after ? Number(after) : 0;
    const slice = source.slice(start, start + pageSize);
    const end = start + slice.length;

    return {
      [field]: {
        edges: slice.map((node, idx) => ({ cursor: String(start + idx), node })),
        pageInfo: { hasNextPage: end < source.length, endCursor: String(end) },
      },
    };
  });
}

function fakePrisma() {
  const backups = [];
  return {
    storeBackup: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `backup-${backups.length + 1}`, ...data };
        backups.push(row);
        return row;
      }),
      update: vi.fn(async ({ where: { id }, data }) => {
        const row = backups.find((b) => b.id === id);
        if (row) Object.assign(row, data);
        return row;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    __getBackups: () => backups,
  };
}

describe("snapshotStore", () => {
  it("captures products and collections with the fields needed to restore", async () => {
    const shopifyGraphql = makeGraphql({ products: [productNode(1)], collections: [collectionNode(1)] });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "2025-10" });

    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.products).toHaveLength(1);
    expect(snapshot.products[0]).toMatchObject({
      id: "gid://shopify/Product/1", handle: "product-1", title: "Product 1",
      vendor: "Acme", productType: "Widget", status: "ACTIVE",
    });
    expect(snapshot.collections).toHaveLength(1);
    expect(snapshot.counts).toEqual({ products: 1, collections: 1, metafields: 0 });
  });

  it("captures metafields on products and counts them", async () => {
    const shopifyGraphql = makeGraphql({
      products: [productNode(1, {
        metafields: [
          { namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field" },
          { namespace: "custom", key: "care", value: "Cold", type: "single_line_text_field" },
        ],
      })],
    });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(snapshot.products[0].metafields).toHaveLength(2);
    expect(snapshot.products[0].metafields[0]).toEqual({
      namespace: "custom", key: "material", value: "Cotton", type: "single_line_text_field",
    });
    expect(snapshot.counts.metafields).toBe(2);
  });

  it("drops metafields missing a namespace or key rather than storing unusable rows", async () => {
    const shopifyGraphql = makeGraphql({
      products: [productNode(1, { metafields: [{ namespace: null, key: "x", value: "1" }, { namespace: "custom", key: "ok", value: "1" }] })],
    });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s", token: "t", version: "2025-10" });
    expect(snapshot.products[0].metafields).toHaveLength(1);
    expect(snapshot.products[0].metafields[0].key).toBe("ok");
  });

  it("paginates through every page", async () => {
    const products = Array.from({ length: 250 }, (_, i) => productNode(i));
    const shopifyGraphql = makeGraphql({ products, pageSize: 100 });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(snapshot.products).toHaveLength(250);
    expect(snapshot.truncated.products).toBe(false);
  });

  it("stops at the product cap and flags truncation rather than silently dropping data", async () => {
    const products = Array.from({ length: MAX_SNAPSHOT_PRODUCTS + 50 }, (_, i) => productNode(i));
    const shopifyGraphql = makeGraphql({ products, pageSize: 100 });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(snapshot.products).toHaveLength(MAX_SNAPSHOT_PRODUCTS);
    expect(snapshot.truncated.products).toBe(true);
  });

  it("stops at the collection cap and flags truncation", async () => {
    const collections = Array.from({ length: MAX_SNAPSHOT_COLLECTIONS + 10 }, (_, i) => collectionNode(i));
    const shopifyGraphql = makeGraphql({ collections, pageSize: 100 });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(snapshot.collections).toHaveLength(MAX_SNAPSHOT_COLLECTIONS);
    expect(snapshot.truncated.collections).toBe(true);
  });

  it("does not loop forever when a page returns no cursor", async () => {
    const shopifyGraphql = vi.fn(async (shop, token, query) => {
      const field = query.includes("BackupProducts") ? "products" : "collections";
      // Malformed: claims another page exists but gives no cursor to fetch it.
      return { [field]: { edges: [{ cursor: "0", node: productNode(1) }], pageInfo: { hasNextPage: true, endCursor: null } } };
    });
    const snapshot = await snapshotStore({ shopifyGraphql, shop: "s", token: "t", version: "2025-10" });
    expect(snapshot.products).toHaveLength(1);
  });
});

describe("createBackup", () => {
  let prisma;

  beforeEach(() => {
    prisma = fakePrisma();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("persists a READY backup with counts and size", async () => {
    const shopifyGraphql = makeGraphql({ products: [productNode(1)], collections: [collectionNode(1)] });
    const result = await createBackup({ prisma, shopifyGraphql, shop: "s.myshopify.com", token: "t", version: "2025-10", jobId: "job-1" });

    expect(result.ok).toBe(true);
    expect(result.backup.status).toBe("READY");
    expect(result.backup.productCount).toBe(1);
    expect(result.backup.collectionCount).toBe(1);
    expect(result.backup.sizeBytes).toBeGreaterThan(0);
    expect(result.backup.jobId).toBe("job-1");
  });

  it("marks the backup PARTIAL when the store exceeded the snapshot cap", async () => {
    const products = Array.from({ length: MAX_SNAPSHOT_PRODUCTS + 1 }, (_, i) => productNode(i));
    const shopifyGraphql = makeGraphql({ products, pageSize: 100 });
    const result = await createBackup({ prisma, shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(result.truncated).toBe(true);
    expect(result.backup.status).toBe("PARTIAL");
    expect(result.backup.truncated).toBe(true);
  });

  it("records a FAILED backup instead of throwing when the snapshot errors", async () => {
    const shopifyGraphql = vi.fn(async () => { throw new Error("403 Forbidden"); });
    const result = await createBackup({ prisma, shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/403 Forbidden/);
    expect(result.backup.status).toBe("FAILED");
    expect(result.backup.error).toMatch(/403 Forbidden/);
  });

  it("still returns a result when even recording the failure fails", async () => {
    const shopifyGraphql = vi.fn(async () => { throw new Error("boom"); });
    prisma.storeBackup.create = vi.fn(async () => { throw new Error("db down"); });
    const result = await createBackup({ prisma, shopifyGraphql, shop: "s", token: "t", version: "2025-10" });

    expect(result.ok).toBe(false);
    expect(result.backup).toBeNull();
  });

  it("sets an expiry in the future based on the retention window", async () => {
    const shopifyGraphql = makeGraphql({ products: [productNode(1)] });
    const fixedNow = new Date("2026-01-01T00:00:00Z");
    const result = await createBackup({
      prisma, shopifyGraphql, shop: "s", token: "t", version: "2025-10",
      retentionDays: 7, now: () => fixedNow,
    });
    expect(result.backup.expiresAt.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("computeExpiry / isExpired / parseSnapshot", () => {
  it("computeExpiry adds the retention window", () => {
    expect(computeExpiry(new Date("2026-01-01T00:00:00Z"), 30).toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("isExpired is true only past expiresAt", () => {
    const backup = { expiresAt: new Date("2026-01-10T00:00:00Z") };
    expect(isExpired(backup, new Date("2026-01-09T00:00:00Z"))).toBe(false);
    expect(isExpired(backup, new Date("2026-01-11T00:00:00Z"))).toBe(true);
  });

  it("parseSnapshot returns null on unreadable payloads rather than throwing", () => {
    expect(parseSnapshot({ data: "not json" })).toBeNull();
    expect(parseSnapshot({ data: "null" })).toBeNull();
    expect(parseSnapshot({})).toBeNull();
  });
});

describe("restoreBackup", () => {
  let prisma;

  function readyBackup(snapshot, overrides = {}) {
    return {
      id: "backup-1",
      shop: "dest.myshopify.com",
      status: "READY",
      truncated: false,
      expiresAt: new Date(Date.now() + 86400000),
      data: JSON.stringify(snapshot),
      ...overrides,
    };
  }

  function snapshotWith(products) {
    return {
      version: SNAPSHOT_VERSION,
      capturedAt: new Date().toISOString(),
      shop: "dest.myshopify.com",
      products,
      collections: [],
      truncated: { products: false, collections: false },
      counts: { products: products.length, collections: 0, metafields: 0 },
    };
  }

  beforeEach(() => {
    prisma = fakePrisma();
    prisma.__getBackups().push({ id: "backup-1" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("re-applies snapshotted values to each product via productUpdate", async () => {
    let sentVariables = null;
    const shopifyGraphql = vi.fn(async (shop, token, query, variables) => {
      sentVariables = variables;
      return { productUpdate: { product: { id: variables.product.id }, userErrors: [] } };
    });
    const backup = readyBackup(snapshotWith([
      { id: "gid://shopify/Product/1", handle: "p-1", title: "Original Title", descriptionHtml: "<p>orig</p>", vendor: "V", productType: "T", tags: ["x"], status: "ACTIVE" },
    ]));

    const result = await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(sentVariables.product).toMatchObject({
      id: "gid://shopify/Product/1", title: "Original Title", vendor: "V", tags: ["x"], status: "ACTIVE",
    });
  });

  it("uses the non-deprecated product: ProductUpdateInput argument", async () => {
    let queryText = null;
    const shopifyGraphql = vi.fn(async (shop, token, query, variables) => {
      queryText = query;
      return { productUpdate: { product: { id: variables.product.id }, userErrors: [] } };
    });
    const backup = readyBackup(snapshotWith([{ id: "gid://shopify/Product/1", title: "T" }]));
    await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(queryText).toMatch(/\$product: ProductUpdateInput!/);
    expect(queryText).not.toMatch(/\$input: ProductInput!/);
  });

  it("counts a product deleted since the snapshot as failed, not restored", async () => {
    const shopifyGraphql = vi.fn(async () => ({
      productUpdate: { product: null, userErrors: [{ field: ["id"], message: "Product does not exist" }] },
    }));
    const backup = readyBackup(snapshotWith([{ id: "gid://shopify/Product/gone", handle: "gone", title: "Gone" }]));

    const result = await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toMatch(/does not exist/);
  });

  it("keeps restoring the rest after one product fails", async () => {
    const shopifyGraphql = vi.fn(async (shop, token, query, variables) => {
      if (variables.product.id.endsWith("/2")) throw new Error("network blip");
      return { productUpdate: { product: { id: variables.product.id }, userErrors: [] } };
    });
    const backup = readyBackup(snapshotWith([
      { id: "gid://shopify/Product/1", title: "A" },
      { id: "gid://shopify/Product/2", title: "B" },
      { id: "gid://shopify/Product/3", title: "C" },
    ]));

    const result = await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(result.restored).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("marks the backup RESTORED afterward", async () => {
    const shopifyGraphql = vi.fn(async (s, t, q, v) => ({ productUpdate: { product: { id: v.product.id }, userErrors: [] } }));
    const backup = readyBackup(snapshotWith([{ id: "gid://shopify/Product/1", title: "A" }]));
    await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(prisma.storeBackup.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "backup-1" },
      data: expect.objectContaining({ status: "RESTORED" }),
    }));
  });

  it("refuses to restore an expired backup", async () => {
    const shopifyGraphql = vi.fn();
    const backup = readyBackup(snapshotWith([{ id: "gid://shopify/Product/1" }]), {
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired/i);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("refuses to restore a backup that never captured successfully", async () => {
    const shopifyGraphql = vi.fn();
    const result = await restoreBackup({
      prisma, shopifyGraphql, token: "t", version: "2025-10",
      backup: { id: "b", shop: "s", status: "FAILED", expiresAt: new Date(Date.now() + 1000) },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to capture/i);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("refuses a snapshot written by an incompatible future version", async () => {
    const shopifyGraphql = vi.fn();
    const backup = readyBackup({ ...snapshotWith([]), version: 999 });

    const result = await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported snapshot version/);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("returns an error for a missing backup instead of throwing", async () => {
    const result = await restoreBackup({ prisma, shopifyGraphql: vi.fn(), backup: null, token: "t", version: "2025-10" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("writes restore outcomes to the transfer log when a buffer is supplied", async () => {
    const shopifyGraphql = vi.fn(async (s, t, q, v) => ({ productUpdate: { product: { id: v.product.id }, userErrors: [] } }));
    const logBuffer = { add: vi.fn(), flush: vi.fn() };
    const backup = readyBackup(snapshotWith([{ id: "gid://shopify/Product/1", title: "A" }]));

    await restoreBackup({ prisma, shopifyGraphql, backup, token: "t", version: "2025-10", logBuffer });

    expect(logBuffer.add).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "product", action: "updated", destId: "gid://shopify/Product/1",
    }));
    expect(logBuffer.flush).toHaveBeenCalled();
  });
});

describe("purgeExpiredBackups", () => {
  it("deletes only backups past their expiry", async () => {
    const prisma = fakePrisma();
    prisma.storeBackup.deleteMany = vi.fn(async () => ({ count: 3 }));
    const now = new Date("2026-01-15T00:00:00Z");

    expect(await purgeExpiredBackups(prisma, now)).toBe(3);
    expect(prisma.storeBackup.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });
});
