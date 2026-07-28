import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SHOP_SCOPED_MODELS, EXEMPT_MODELS, deleteShopData, summarizeErasure,
} from "./shop-data.server.js";

function fakePrisma({ jobs = [], failOn = [] } = {}) {
  const calls = [];
  const model = (name) => ({
    deleteMany: vi.fn(async ({ where }) => {
      calls.push({ model: name, where });
      if (failOn.includes(name)) throw new Error(`no such table: ${name}`);
      return { count: 1 };
    }),
    findMany: vi.fn(async () => jobs),
  });

  const prisma = {};
  for (const name of SHOP_SCOPED_MODELS) prisma[name] = model(name);
  prisma.__calls = () => calls;
  return prisma;
}

describe("shop data inventory", () => {
  // The whole point of this module is that erasure can't silently fall
  // behind the schema. This reads schema.prisma directly rather than
  // trusting a hand-maintained list.
  it("covers every model declared in prisma/schema.prisma", () => {
    const schemaPath = path.resolve(process.cwd(), "prisma/schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf8");
    const declared = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

    // Prisma client properties are the model name with a lowercase initial.
    const toClientKey = (name) => name.charAt(0).toLowerCase() + name.slice(1);
    const accountedFor = new Set([...SHOP_SCOPED_MODELS, ...Object.keys(EXEMPT_MODELS)]);

    const unaccounted = declared.map(toClientKey).filter((k) => !accountedFor.has(k));

    expect(
      unaccounted,
      `Model(s) ${unaccounted.join(", ")} exist in schema.prisma but are neither deleted on ` +
      `shop/redact nor listed in EXEMPT_MODELS. Add them to SHOP_SCOPED_MODELS (GDPR erasure) ` +
      `or to EXEMPT_MODELS with a documented reason.`,
    ).toEqual([]);
  });

  it("does not list a model that no longer exists in the schema", () => {
    const schema = fs.readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const declared = new Set(
      [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1].charAt(0).toLowerCase() + m[1].slice(1)),
    );
    const stale = SHOP_SCOPED_MODELS.filter((m) => !declared.has(m));
    expect(stale, `SHOP_SCOPED_MODELS references removed model(s): ${stale.join(", ")}`).toEqual([]);
  });

  // Regression guard for a bug a live smoke test caught that these unit
  // tests did not: deleteShopData issued `where: { shop }` against
  // TransferSession, which has no `shop` column (it has sourceShop/destShop).
  // Prisma rejected the query, the per-model catch swallowed it, and the rows
  // survived erasure still holding both stores' encrypted tokens.
  //
  // The fake Prisma below accepts any where-clause, so only checking the
  // clause against the real schema can catch this class of mistake.
  it("only filters on columns that actually exist on each model", async () => {
    const schema = fs.readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

    // model Name { ... } → set of field names
    const columnsByModel = {};
    for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const clientKey = m[1].charAt(0).toLowerCase() + m[1].slice(1);
      columnsByModel[clientKey] = new Set(
        m[2].split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
          .map((l) => l.split(/\s+/)[0]),
      );
    }

    const prisma = fakePrisma({ jobs: [{ id: "job-1" }] });
    await deleteShopData(prisma, "merchant.myshopify.com");

    // Collects every field name referenced in a where clause, including
    // inside OR/AND/NOT groupings.
    const fieldsIn = (where) => {
      const found = [];
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (["OR", "AND", "NOT"].includes(key)) walk(value);
          else found.push(key);
        }
      };
      walk(where);
      return found;
    };

    const problems = [];
    for (const { model, where } of prisma.__calls()) {
      const columns = columnsByModel[model];
      if (!columns) { problems.push(`${model}: not found in schema`); continue; }
      for (const field of fieldsIn(where)) {
        if (!columns.has(field)) problems.push(`${model}.${field} does not exist`);
      }
    }

    expect(
      problems,
      `deleteShopData filters on non-existent column(s). Prisma rejects these at runtime and the ` +
      `per-model catch hides it, so the rows silently survive GDPR erasure:\n  ${problems.join("\n  ")}`,
    ).toEqual([]);
  });

  it("removes a TransferSession when either side of the store pair is redacted", async () => {
    // It records a pairing and holds BOTH stores' encrypted tokens, so a
    // redact of the source or the destination must remove it.
    const prisma = fakePrisma({ jobs: [] });
    await deleteShopData(prisma, "merchant.myshopify.com");

    const call = prisma.__calls().find((c) => c.model === "transferSession");
    expect(call.where).toEqual({
      OR: [{ sourceShop: "merchant.myshopify.com" }, { destShop: "merchant.myshopify.com" }],
    });
  });

  it("deletes child rows before their parent job", () => {
    // Once MigrationJob rows are gone, ProductMapping/TransferLogEntry are
    // unreachable, so they must come first.
    const jobIdx = SHOP_SCOPED_MODELS.indexOf("migrationJob");
    expect(SHOP_SCOPED_MODELS.indexOf("productMapping")).toBeLessThan(jobIdx);
    expect(SHOP_SCOPED_MODELS.indexOf("transferLogEntry")).toBeLessThan(jobIdx);
  });
});

describe("deleteShopData", () => {
  const SHOP = "merchant.myshopify.com";

  it("deletes from every shop-scoped model", async () => {
    const prisma = fakePrisma({ jobs: [{ id: "job-1" }] });
    const { deleted, errors } = await deleteShopData(prisma, SHOP);

    expect(errors).toEqual([]);
    for (const model of SHOP_SCOPED_MODELS) {
      expect(Object.keys(deleted)).toContain(model);
    }
  });

  it("clears the tables the old implementation left behind", async () => {
    const prisma = fakePrisma({ jobs: [{ id: "job-1" }] });
    await deleteShopData(prisma, SHOP);
    const touched = prisma.__calls().map((c) => c.model);

    // These hold access tokens, a full catalog snapshot, and transfer
    // history respectively — none were deleted before this change.
    expect(touched).toContain("migrationJob");
    expect(touched).toContain("scheduledSync");
    expect(touched).toContain("storeBackup");
    expect(touched).toContain("transferSession");
    expect(touched).toContain("productMapping");
    expect(touched).toContain("transferLogEntry");
  });

  it("scopes shop-keyed models by shop domain", async () => {
    const prisma = fakePrisma({ jobs: [] });
    await deleteShopData(prisma, SHOP);
    const sessionCall = prisma.__calls().find((c) => c.model === "session");
    expect(sessionCall.where).toEqual({ shop: SHOP });
  });

  it("scopes job-keyed children by their parent job ids", async () => {
    const prisma = fakePrisma({ jobs: [{ id: "job-1" }, { id: "job-2" }] });
    await deleteShopData(prisma, SHOP);

    const mappingCall = prisma.__calls().find((c) => c.model === "productMapping");
    expect(mappingCall.where).toEqual({ jobId: { in: ["job-1", "job-2"] } });
  });

  it("skips job-keyed children entirely when the shop has no jobs", async () => {
    const prisma = fakePrisma({ jobs: [] });
    const { deleted } = await deleteShopData(prisma, SHOP);

    expect(prisma.__calls().find((c) => c.model === "productMapping")).toBeUndefined();
    expect(deleted.productMapping).toBe(0);
  });

  it("keeps deleting the remaining models when one fails", async () => {
    // A missing table on an older deployment must not abort the erasure.
    const prisma = fakePrisma({ jobs: [{ id: "job-1" }], failOn: ["storeBackup"] });
    const { deleted, errors } = await deleteShopData(prisma, SHOP);

    expect(errors).toHaveLength(1);
    expect(errors[0].model).toBe("storeBackup");
    expect(deleted.session).toBe(1); // later models still processed
    expect(deleted.migrationJob).toBe(1);
  });

  it("reports failures rather than silently under-deleting", async () => {
    const prisma = fakePrisma({ jobs: [{ id: "job-1" }], failOn: ["scheduledSync", "storeBackup"] });
    const { errors } = await deleteShopData(prisma, SHOP);

    expect(errors.map((e) => e.model).sort()).toEqual(["scheduledSync", "storeBackup"]);
  });

  it("refuses to run without a shop domain, rather than deleting broadly", async () => {
    const prisma = fakePrisma();
    const { deleted, errors } = await deleteShopData(prisma, "");

    expect(Object.keys(deleted)).toHaveLength(0);
    expect(errors[0].error).toMatch(/No shop domain/);
    expect(prisma.__calls()).toEqual([]);
  });

  it("survives the job lookup itself failing", async () => {
    const prisma = fakePrisma({ jobs: [{ id: "job-1" }] });
    prisma.migrationJob.findMany = vi.fn(async () => { throw new Error("db locked"); });

    const { errors, deleted } = await deleteShopData(prisma, SHOP);

    expect(errors.some((e) => e.model === "migrationJob(lookup)")).toBe(true);
    expect(deleted.session).toBe(1); // erasure still proceeds
  });
});

describe("summarizeErasure", () => {
  it("totals deleted records and failures", () => {
    const summary = summarizeErasure({
      deleted: { session: 2, storeBackup: 3 },
      errors: [{ model: "importJob", error: "x" }],
    });
    expect(summary).toEqual({ totalRecordsDeleted: 5, modelsCleared: 2, failures: 1 });
  });

  it("handles an empty result", () => {
    expect(summarizeErasure({ deleted: {}, errors: [] })).toEqual({
      totalRecordsDeleted: 0, modelsCleared: 0, failures: 0,
    });
  });
});
