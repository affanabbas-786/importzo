// Phase 4 — Field-mapping template CRUD.
//
// GET  /api/mapping-templates?importType=products         → list this shop's templates
// POST /api/mapping-templates  intent=save   (name, importType, mapping)
// POST /api/mapping-templates  intent=delete (id)
//
// Scoped to the authenticated shop throughout — a template belonging to
// another shop 404s the same as one that never existed (api.backup.jsx
// precedent), so this endpoint can't be used to probe another store's ids.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  listMappingTemplates, saveMappingTemplate, deleteMappingTemplate, parseTemplateMapping,
} from "../lib/mapping-templates.server";
import { withPolicy } from "../lib/rate-limit.server";

function serialize(row) {
  return {
    id: row.id,
    name: row.name,
    importType: row.importType,
    mapping: parseTemplateMapping(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const importType = url.searchParams.get("importType") || "products";

  const rows = await listMappingTemplates({ prisma, shop: session.shop, importType });
  return Response.json({ ok: true, templates: rows.map(serialize) });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  return withPolicy({ policyName: "mappingTemplate", shop: session.shop }, async () => {
    if (intent === "save") {
      let mapping;
      try {
        mapping = JSON.parse(formData.get("mapping") || "{}");
      } catch {
        return Response.json({ ok: false, error: "Invalid mapping payload" }, { status: 400 });
      }
      const result = await saveMappingTemplate({
        prisma,
        shop: session.shop,
        importType: (formData.get("importType") || "products").trim(),
        name: formData.get("name"),
        mapping,
      });
      if (!result.ok) return Response.json(result, { status: 400 });
      return Response.json({ ok: true, template: serialize(result.template) });
    }

    if (intent === "delete") {
      const id = (formData.get("id") || "").trim();
      if (!id) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });
      const result = await deleteMappingTemplate({ prisma, shop: session.shop, id });
      if (!result.ok) return Response.json(result, { status: 404 });
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
  });
};
