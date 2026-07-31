import { describe, it, expect, vi } from "vitest";
import {
  listMappingTemplates, getMappingTemplate, saveMappingTemplate,
  deleteMappingTemplate, parseTemplateMapping,
} from "./mapping-templates.server.js";

function fakePrisma() {
  const rows = [];
  let seq = 0;
  return {
    fieldMappingTemplate: {
      findMany: vi.fn(async ({ where, orderBy }) => {
        let out = rows.filter((r) => r.shop === where.shop && r.importType === where.importType);
        if (orderBy?.updatedAt === "desc") out = [...out].sort((a, b) => b.updatedAt - a.updatedAt);
        return out;
      }),
      findUnique: vi.fn(async ({ where }) => {
        if (where.id) return rows.find((r) => r.id === where.id) || null;
        if (where.shop_importType_name) {
          const { shop, importType, name } = where.shop_importType_name;
          return rows.find((r) => r.shop === shop && r.importType === importType && r.name === name) || null;
        }
        return null;
      }),
      count: vi.fn(async ({ where }) => rows.filter((r) => r.shop === where.shop && r.importType === where.importType).length),
      upsert: vi.fn(async ({ where, create, update }) => {
        const { shop, importType, name } = where.shop_importType_name;
        const existing = rows.find((r) => r.shop === shop && r.importType === importType && r.name === name);
        if (existing) { Object.assign(existing, update, { updatedAt: new Date(++seq) }); return existing; }
        const row = { id: `tmpl-${++seq}`, createdAt: new Date(seq), updatedAt: new Date(seq), ...create };
        rows.push(row);
        return row;
      }),
      delete: vi.fn(async ({ where }) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx >= 0) rows.splice(idx, 1);
      }),
    },
    __rows: () => rows,
  };
}

const SHOP = "dest-shop.myshopify.com";

describe("saveMappingTemplate", () => {
  it("creates a new template", async () => {
    const prisma = fakePrisma();
    const result = await saveMappingTemplate({
      prisma, shop: SHOP, importType: "products", name: "My Supplier",
      mapping: { title: "title", cost: "price" },
    });
    expect(result.ok).toBe(true);
    expect(result.template.name).toBe("My Supplier");
    expect(JSON.parse(result.template.mapping)).toEqual({ title: "title", cost: "price" });
  });

  it("updates in place when saved again under the same name", async () => {
    const prisma = fakePrisma();
    await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "Weekly", mapping: { a: "title" } });
    const second = await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "Weekly", mapping: { a: "title", b: "price" } });
    expect(second.ok).toBe(true);
    expect(prisma.__rows()).toHaveLength(1); // upsert, not a duplicate row
    expect(JSON.parse(second.template.mapping)).toEqual({ a: "title", b: "price" });
  });

  it("rejects an empty name", async () => {
    const prisma = fakePrisma();
    const result = await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "  ", mapping: { a: "title" } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name/i);
  });

  it("rejects an empty mapping", async () => {
    const prisma = fakePrisma();
    const result = await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "X", mapping: {} });
    expect(result.ok).toBe(false);
  });

  it("keeps templates scoped per importType — same name allowed under a different type", async () => {
    const prisma = fakePrisma();
    await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "Weekly", mapping: { a: "title" } });
    const woo = await saveMappingTemplate({ prisma, shop: SHOP, importType: "woocommerce", name: "Weekly", mapping: { a: "title" } });
    expect(woo.ok).toBe(true);
    expect(prisma.__rows()).toHaveLength(2);
  });

  it("enforces a per-scope template limit so one shop can't grow this table unbounded", async () => {
    const prisma = fakePrisma();
    for (let i = 0; i < 50; i++) {
      const r = await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: `t${i}`, mapping: { a: "title" } });
      expect(r.ok).toBe(true);
    }
    const overflow = await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "t50", mapping: { a: "title" } });
    expect(overflow.ok).toBe(false);
    expect(overflow.error).toMatch(/limit/i);
  });
});

describe("listMappingTemplates / getMappingTemplate", () => {
  it("scopes listing to shop + importType", async () => {
    const prisma = fakePrisma();
    await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "Mine", mapping: { a: "title" } });
    await saveMappingTemplate({ prisma, shop: "someone-else.myshopify.com", importType: "products", name: "Theirs", mapping: { a: "title" } });
    const list = await listMappingTemplates({ prisma, shop: SHOP, importType: "products" });
    expect(list.map((t) => t.name)).toEqual(["Mine"]);
  });

  it("treats another shop's template id as not found, not forbidden", async () => {
    const prisma = fakePrisma();
    const saved = await saveMappingTemplate({ prisma, shop: "someone-else.myshopify.com", importType: "products", name: "Theirs", mapping: { a: "title" } });
    const got = await getMappingTemplate({ prisma, shop: SHOP, id: saved.template.id });
    expect(got).toBeNull();
  });
});

describe("deleteMappingTemplate", () => {
  it("deletes a template owned by the shop", async () => {
    const prisma = fakePrisma();
    const saved = await saveMappingTemplate({ prisma, shop: SHOP, importType: "products", name: "X", mapping: { a: "title" } });
    const result = await deleteMappingTemplate({ prisma, shop: SHOP, id: saved.template.id });
    expect(result.ok).toBe(true);
    expect(prisma.__rows()).toHaveLength(0);
  });

  it("refuses to delete another shop's template", async () => {
    const prisma = fakePrisma();
    const saved = await saveMappingTemplate({ prisma, shop: "someone-else.myshopify.com", importType: "products", name: "X", mapping: { a: "title" } });
    const result = await deleteMappingTemplate({ prisma, shop: SHOP, id: saved.template.id });
    expect(result.ok).toBe(false);
    expect(prisma.__rows()).toHaveLength(1); // untouched
  });
});

describe("parseTemplateMapping", () => {
  it("parses valid JSON", () => {
    expect(parseTemplateMapping({ mapping: JSON.stringify({ a: "title" }) })).toEqual({ a: "title" });
  });

  it("returns an empty object for corrupt JSON rather than throwing", () => {
    expect(parseTemplateMapping({ mapping: "{not json" })).toEqual({});
  });

  it("returns an empty object when the stored value isn't a plain object", () => {
    expect(parseTemplateMapping({ mapping: JSON.stringify(["a", "b"]) })).toEqual({});
  });
});
