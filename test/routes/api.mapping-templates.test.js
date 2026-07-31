import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildFormData } from "../../app/lib/test-helpers.js";

const db = { templates: [] };
let seq = 0;

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "dest-shop.myshopify.com", accessToken: "dest-token" } })) },
}));

vi.mock("../../app/db.server", () => ({
  default: {
    fieldMappingTemplate: {
      findMany: vi.fn(async ({ where }) =>
        db.templates.filter((t) => t.shop === where.shop && t.importType === where.importType)
          .sort((a, b) => b.updatedAt - a.updatedAt)),
      findUnique: vi.fn(async ({ where }) => {
        if (where.id) return db.templates.find((t) => t.id === where.id) || null;
        if (where.shop_importType_name) {
          const { shop, importType, name } = where.shop_importType_name;
          return db.templates.find((t) => t.shop === shop && t.importType === importType && t.name === name) || null;
        }
        return null;
      }),
      count: vi.fn(async ({ where }) => db.templates.filter((t) => t.shop === where.shop && t.importType === where.importType).length),
      upsert: vi.fn(async ({ where, create, update }) => {
        const { shop, importType, name } = where.shop_importType_name;
        const existing = db.templates.find((t) => t.shop === shop && t.importType === importType && t.name === name);
        if (existing) { Object.assign(existing, update, { updatedAt: new Date(++seq) }); return existing; }
        const row = { id: `tmpl-${++seq}`, createdAt: new Date(seq), updatedAt: new Date(seq), ...create };
        db.templates.push(row);
        return row;
      }),
      delete: vi.fn(async ({ where }) => {
        const idx = db.templates.findIndex((t) => t.id === where.id);
        if (idx >= 0) db.templates.splice(idx, 1);
      }),
    },
  },
}));

import { loader, action } from "../../app/routes/api.mapping-templates.jsx";
import { __resetRateLimitState } from "../../app/lib/rate-limit.server.js";

describe("api.mapping-templates", () => {
  beforeEach(() => {
    db.templates = [];
    seq = 0;
    __resetRateLimitState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loader (list)", () => {
    it("lists templates scoped to shop + importType", async () => {
      db.templates.push({ id: "t1", shop: "dest-shop.myshopify.com", importType: "products", name: "Mine", mapping: JSON.stringify({ a: "title" }), createdAt: new Date(), updatedAt: new Date() });
      db.templates.push({ id: "t2", shop: "dest-shop.myshopify.com", importType: "woocommerce", name: "Wrong type", mapping: "{}", createdAt: new Date(), updatedAt: new Date() });
      db.templates.push({ id: "t3", shop: "other-shop.myshopify.com", importType: "products", name: "Not mine", mapping: "{}", createdAt: new Date(), updatedAt: new Date() });

      const response = await loader({ request: { url: "https://app.test/api/mapping-templates?importType=products" } });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.templates).toHaveLength(1);
      expect(body.templates[0].name).toBe("Mine");
      expect(body.templates[0].mapping).toEqual({ a: "title" });
    });

    it("defaults to importType=products when omitted", async () => {
      db.templates.push({ id: "t1", shop: "dest-shop.myshopify.com", importType: "products", name: "Mine", mapping: "{}", createdAt: new Date(), updatedAt: new Date() });
      const response = await loader({ request: { url: "https://app.test/api/mapping-templates" } });
      const body = await response.json();
      expect(body.templates).toHaveLength(1);
    });
  });

  describe("action (save)", () => {
    it("saves a new template", async () => {
      const request = {
        method: "POST",
        formData: async () => buildFormData({ intent: "save", importType: "products", name: "Supplier A", mapping: { title: "title", cost: "price" } }),
      };
      const response = await action({ request });
      const body = await response.json();

      expect(body.ok).toBe(true);
      expect(body.template.name).toBe("Supplier A");
      expect(body.template.mapping).toEqual({ title: "title", cost: "price" });
    });

    it("rejects malformed mapping JSON with 400", async () => {
      const request = {
        method: "POST",
        formData: async () => {
          const fd = new FormData();
          fd.append("intent", "save");
          fd.append("importType", "products");
          fd.append("name", "Bad");
          fd.append("mapping", "{not json");
          return fd;
        },
      };
      const response = await action({ request });
      expect(response.status).toBe(400);
    });

    it("rejects an empty name with 400", async () => {
      const request = {
        method: "POST",
        formData: async () => buildFormData({ intent: "save", importType: "products", name: "", mapping: { a: "title" } }),
      };
      const response = await action({ request });
      expect(response.status).toBe(400);
    });
  });

  describe("action (delete)", () => {
    it("deletes a template owned by the shop", async () => {
      db.templates.push({ id: "t1", shop: "dest-shop.myshopify.com", importType: "products", name: "Mine", mapping: "{}", createdAt: new Date(), updatedAt: new Date() });
      const request = { method: "POST", formData: async () => buildFormData({ intent: "delete", id: "t1" }) };
      const response = await action({ request });
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(db.templates).toHaveLength(0);
    });

    it("404s deleting another shop's template, without confirming it exists", async () => {
      db.templates.push({ id: "t1", shop: "other-shop.myshopify.com", importType: "products", name: "Not mine", mapping: "{}", createdAt: new Date(), updatedAt: new Date() });
      const request = { method: "POST", formData: async () => buildFormData({ intent: "delete", id: "t1" }) };
      const response = await action({ request });
      expect(response.status).toBe(404);
      expect(db.templates).toHaveLength(1); // untouched
    });
  });

  it("rejects non-POST methods on the action", async () => {
    const response = await action({ request: { method: "GET" } });
    expect(response.status).toBe(405);
  });

  it("rejects an unknown intent", async () => {
    const request = { method: "POST", formData: async () => buildFormData({ intent: "bogus" }) };
    const response = await action({ request });
    expect(response.status).toBe(400);
  });
});
