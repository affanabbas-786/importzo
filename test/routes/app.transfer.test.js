import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jsonResponse, mockActionRequest } from "../../app/lib/test-helpers.js";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
  apiVersion: "2025-10",
}));

vi.mock("../../app/db.server", () => ({
  default: {
    transferSession: { findUnique: vi.fn() },
    sourceStore: { findUnique: vi.fn(), upsert: vi.fn() },
    importJob: { create: vi.fn() },
  },
}));

import { action } from "../../app/routes/app.transfer.jsx";

const SOURCE_SHOP = "source-shop.myshopify.com";
const DEST_SHOP = "dest-shop.myshopify.com";

const emptyEdges = (field) => jsonResponse({ data: { [field]: { edges: [], pageInfo: { hasNextPage: false } } } });

// Dispatches based on which shop the request targets and what the GraphQL
// query/mutation contains, so call ORDER doesn't need to be hand-scripted —
// robust regardless of how transferContentAndMedia sequences its sub-calls.
function makeContentTransferFetch({ sourceFiles = [], destExistingFilenames = [], fileCreateHandler } = {}) {
  return vi.fn(async (url, opts) => {
    const isSource = url.startsWith(`https://${SOURCE_SHOP}`);
    const isDest = url.startsWith(`https://${DEST_SHOP}`);
    const body = opts?.body ? JSON.parse(opts.body) : {};
    const query = body.query || "";

    if (query.includes("query StoreFiles")) {
      if (isSource) {
        return jsonResponse({
          data: {
            files: {
              edges: sourceFiles.map((f, i) => ({
                cursor: String(i),
                node: { id: `gid://shopify/GenericFile/${i}`, alt: f.filename, fileStatus: "READY", url: f.originalSource },
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      if (isDest) {
        return jsonResponse({
          data: {
            files: {
              edges: destExistingFilenames.map((filename, i) => ({
                cursor: String(i),
                node: { id: `gid://shopify/GenericFile/dest-${i}`, alt: filename, fileStatus: "READY", url: `https://${DEST_SHOP}/cdn/shop/files/${filename}` },
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
    }

    if (query.includes("mutation fileCreate")) {
      if (fileCreateHandler) return fileCreateHandler(body);
      const files = (body.variables?.files || []).map((f, i) => ({ id: `gid://shopify/GenericFile/new-${i}`, fileStatus: "READY", alt: f.alt }));
      return jsonResponse({ data: { fileCreate: { files, userErrors: [] } } });
    }

    if (query.includes("query SourcePages")) return emptyEdges("pages");
    if (query.includes("query SourceBlogs")) return emptyEdges("blogs");
    if (query.includes("query SourcePolicies")) return jsonResponse({ data: { shop: { shopPolicies: [] } } });
    if (query.includes("menus(first")) return emptyEdges("menus");

    return jsonResponse({ data: {} });
  });
}

describe("app.transfer action — transfer-content idempotency (file dedupe)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies files that don't yet exist on the destination", async () => {
    global.fetch = makeContentTransferFetch({
      sourceFiles: [{ filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` }],
      destExistingFilenames: [],
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.total).toBe(1);
    expect(fileResult.copied).toBe(1);
    expect(fileResult.skipped).toBe(0);
  });

  it("skips files that already exist on the destination instead of duplicating them", async () => {
    global.fetch = makeContentTransferFetch({
      sourceFiles: [
        { filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` },
        { filename: "new-banner.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/new-banner.jpg` },
      ],
      destExistingFilenames: ["hero.jpg"], // already present on destination
    });
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const result = await action({ request: req });

    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.total).toBe(2);
    expect(fileResult.skipped).toBe(1);
    expect(fileResult.copied).toBe(1); // only new-banner.jpg was actually created
  });

  it("re-running the same content transfer a second time skips everything (fully idempotent)", async () => {
    const sourceFiles = [{ filename: "hero.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/hero.jpg` }];
    global.fetch = makeContentTransferFetch({ sourceFiles, destExistingFilenames: [] });
    const req1 = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const first = await action({ request: req1 });
    expect(first.results.find((r) => r.type === "files").copied).toBe(1);

    // Second run: destination now already has hero.jpg from the first run.
    global.fetch = makeContentTransferFetch({ sourceFiles, destExistingFilenames: ["hero.jpg"] });
    const req2 = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token" });
    const second = await action({ request: req2 });
    const secondFiles = second.results.find((r) => r.type === "files");
    expect(secondFiles.copied).toBe(0);
    expect(secondFiles.skipped).toBe(1);
  });

  it("dry run never queries the destination store for files", async () => {
    const fetchSpy = makeContentTransferFetch({ sourceFiles: [{ filename: "a.jpg", originalSource: `https://${SOURCE_SHOP}/cdn/shop/files/a.jpg` }] });
    global.fetch = fetchSpy;
    const req = mockActionRequest({ intent: "transfer-content", sourceUrl: SOURCE_SHOP, sourceToken: "src-token", dryRun: "true" });
    const result = await action({ request: req });

    const fileResult = result.results.find((r) => r.type === "files");
    expect(fileResult.status).toBe("dry-run");
    expect(fetchSpy.mock.calls.some((c) => c[0].startsWith(`https://${DEST_SHOP}`))).toBe(false);
  });
});

describe("app.transfer action — transfer-theme idempotency", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips theme creation when a theme with the same generated name already exists on the destination", async () => {
    global.fetch = vi.fn(async (url, opts) => {
      if (url.includes(`${SOURCE_SHOP}/admin/api/2025-10/themes/123/assets.json`) && !url.includes("asset[key]")) {
        return jsonResponse({ assets: [{ key: "layout/theme.liquid" }, { key: "config/settings_schema.json" }] });
      }
      if (opts?.body && JSON.parse(opts.body).query?.includes("shop { name }")) {
        return jsonResponse({ data: { shop: { name: "Source Shop" } } });
      }
      if (url === `https://${DEST_SHOP}/admin/api/2025-10/themes.json` && (!opts || opts.method === undefined)) {
        return jsonResponse({ themes: [{ id: 999, name: "My Theme (Transferred)" }] });
      }
      throw new Error(`Unexpected fetch in idempotency test: ${url}`);
    });

    const req = mockActionRequest({
      intent: "transfer-theme",
      sourceUrl: SOURCE_SHOP,
      sourceToken: "src-token",
      themeId: "123",
      themeName: "My Theme",
    });
    const result = await action({ request: req });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.newThemeId).toBe(999);
    expect(result.message).toMatch(/already exists/i);
  });
});
