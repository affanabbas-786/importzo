// ═══════════════════════════════════════════════════════════════════
// Phase 4 — Field-mapping templates.
//
// Lets a merchant save a CSV column → Shopify field mapping (built with
// smart-mapper.js's templateFromMapping/applyMappingTemplate) so a
// recurring import (e.g. a monthly supplier feed) doesn't need re-mapping
// every time. Scoped per shop + importType, keyed by a merchant-chosen
// name so the same shop can keep separate templates per supplier.
//
// `prisma` is injected rather than imported directly so tests can pass a
// fake — same convention as backup.server.js / rollback.server.js.
// ═══════════════════════════════════════════════════════════════════

const MAX_TEMPLATES_PER_SCOPE = 50; // guards against unbounded growth on shared VPS

export async function listMappingTemplates({ prisma, shop, importType }) {
  return prisma.fieldMappingTemplate.findMany({
    where: { shop, importType },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, importType: true, mapping: true, createdAt: true, updatedAt: true },
  });
}

export async function getMappingTemplate({ prisma, shop, id }) {
  const row = await prisma.fieldMappingTemplate.findUnique({ where: { id } });
  if (!row || row.shop !== shop) return null; // scoped like api.backup.jsx: not-found, not 403
  return row;
}

/**
 * Creates or updates (by shop+importType+name) a saved mapping. `mapping`
 * is a plain object ({ [csvHeaderText]: shopifyField }) — see
 * smart-mapper.js's templateFromMapping.
 */
export async function saveMappingTemplate({ prisma, shop, importType, name, mapping }) {
  const trimmedName = (name || "").trim();
  if (!trimmedName) return { ok: false, error: "Template name is required" };
  if (!importType) return { ok: false, error: "Missing importType" };
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return { ok: false, error: "Invalid mapping" };
  }
  const fieldCount = Object.keys(mapping).length;
  if (fieldCount === 0) return { ok: false, error: "Mapping has no columns to save" };

  const existingCount = await prisma.fieldMappingTemplate.count({ where: { shop, importType } });
  const existing = await prisma.fieldMappingTemplate.findUnique({
    where: { shop_importType_name: { shop, importType, name: trimmedName } },
  }).catch(() => null); // some fakes may not implement the compound-key lookup

  if (!existing && existingCount >= MAX_TEMPLATES_PER_SCOPE) {
    return { ok: false, error: `Limit of ${MAX_TEMPLATES_PER_SCOPE} saved templates reached for this import type. Delete one first.` };
  }

  const data = { shop, importType, name: trimmedName, mapping: JSON.stringify(mapping) };
  const row = await prisma.fieldMappingTemplate.upsert({
    where: { shop_importType_name: { shop, importType, name: trimmedName } },
    create: data,
    update: { mapping: data.mapping },
  });
  return { ok: true, template: row };
}

export async function deleteMappingTemplate({ prisma, shop, id }) {
  const existing = await getMappingTemplate({ prisma, shop, id });
  if (!existing) return { ok: false, error: "Template not found" };
  await prisma.fieldMappingTemplate.delete({ where: { id } });
  return { ok: true };
}

/** Parses the stored JSON mapping, never throwing on a corrupt row. */
export function parseTemplateMapping(row) {
  try {
    const parsed = JSON.parse(row.mapping);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
