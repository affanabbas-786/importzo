// ═══════════════════════════════════════════════════════════════════
// Phase 3 — Shop data inventory + GDPR erasure.
//
// Single source of truth for "everything this app stores about a shop".
// shop/redact previously deleted 3 of 9 tables, leaving behind
// MigrationJob and ScheduledSync (both hold encrypted access tokens),
// StoreBackup (holds a full snapshot of the shop's catalog),
// TransferSession, ProductMapping and TransferLogEntry.
//
// The list lives here, next to a test that cross-checks it against
// prisma/schema.prisma, so a future model can't be added without either
// being wired into erasure or being explicitly declared exempt. Getting
// this wrong is a GDPR violation, and "we forgot the new table" is the
// most likely way it happens.
// ═══════════════════════════════════════════════════════════════════

// Models keyed by the shop domain, deleted wholesale on shop/redact.
// Order matters: children before parents, so a partial failure can't
// orphan rows that no longer have a discoverable owner.
export const SHOP_SCOPED_MODELS = Object.freeze([
  "transferLogEntry", // child of MigrationJob (by jobId) — see deleteShopData
  "productMapping",   // child of MigrationJob (by jobId) — see deleteShopData
  "storeBackup",
  "migrationJob",
  "scheduledSync",
  "transferSession",
  "sourceStore",
  "importJob",
  "session",
]);

// Models deliberately NOT deleted, with the reason. Anything in neither
// list fails the schema cross-check test.
export const EXEMPT_MODELS = Object.freeze({});

// ProductMapping and TransferLogEntry have no `shop` column — they hang off
// MigrationJob by jobId. They're deleted via their parent's ids.
const JOB_SCOPED_MODELS = Object.freeze(["transferLogEntry", "productMapping"]);

/**
 * Deletes every record this app holds for `shop`.
 *
 * Best-effort per model: a table missing on an older deployment, or one
 * model failing, must not prevent the rest of the erasure. Every outcome is
 * reported so the caller can log precisely what was and wasn't removed —
 * silently under-deleting is the failure mode that matters here.
 */
export async function deleteShopData(prisma, shop) {
  const deleted = {};
  const errors = [];

  if (!shop) return { deleted, errors: [{ model: "(all)", error: "No shop domain supplied" }] };

  // Resolve job ids first: once MigrationJob rows are gone, their children
  // are unreachable.
  let jobIds = [];
  try {
    const jobs = await prisma.migrationJob.findMany({ where: { shop }, select: { id: true } });
    jobIds = jobs.map((j) => j.id);
  } catch (err) {
    errors.push({ model: "migrationJob(lookup)", error: err?.message || String(err) });
  }

  for (const model of SHOP_SCOPED_MODELS) {
    try {
      const where = JOB_SCOPED_MODELS.includes(model)
        ? { jobId: { in: jobIds } }
        : { shop };

      // Nothing to delete if the parent lookup found no jobs.
      if (JOB_SCOPED_MODELS.includes(model) && jobIds.length === 0) {
        deleted[model] = 0;
        continue;
      }

      const result = await prisma[model].deleteMany({ where });
      deleted[model] = result?.count ?? 0;
    } catch (err) {
      // Table may not exist on an older deployment, or the model may be
      // absent from a stale generated client.
      errors.push({ model, error: err?.message || String(err) });
    }
  }

  return { deleted, errors };
}

export function summarizeErasure({ deleted, errors }) {
  const total = Object.values(deleted || {}).reduce((sum, n) => sum + n, 0);
  return {
    totalRecordsDeleted: total,
    modelsCleared: Object.keys(deleted || {}).length,
    failures: (errors || []).length,
  };
}
