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

import { clearStagedAssets, deleteThemeZipNow } from "./theme-zip.server.js";
import { isComplimentary } from "./plans.js";

// Personal-data fields on ShopPlan. On shop/redact these are erased even when
// the row itself is retained for a complimentary grant (see deleteShopData) —
// GDPR requires the personal data to go; it does not require throwing away a
// deliberate, unbilled free grant that has no billing record anywhere else.
const SHOPPLAN_PII_FIELDS = Object.freeze({
  shopOwnerEmail: null, // Admin `shop { email }` — a person's contact address
  recordsUsed: 0,       // activity signal; meaningless without an active install
  aiCallsUsed: 0,       // same
});

// Models keyed by the shop domain, deleted wholesale on shop/redact.
// Order matters: children before parents, so a partial failure can't
// orphan rows that no longer have a discoverable owner.
export const SHOP_SCOPED_MODELS = Object.freeze([
  "transferLogEntry", // child of MigrationJob (by jobId) — see deleteShopData
  "productMapping",   // child of MigrationJob (by jobId) — see deleteShopData
  "storeBackup",
  "migrationJob",
  // Phase 11 — background theme transfer. Holds BOTH stores' encrypted
  // access tokens and the same actorEmail/actorIp audit trail MigrationJob
  // does, so it is erasure-critical for exactly the same reasons. It also
  // owns files outside the database (a staging directory of theme assets
  // and a packaged ZIP); deleteShopData removes those too — see below.
  "themeJob",
  "scheduledSync",
  "transferSession",
  "sourceStore",
  "importJob",
  "fieldMappingTemplate", // Phase 4 — saved CSV mappings, shop-owned config
  "aiIntegration", // Phase 4.4 — merchant's own encrypted LLM API key
  "shopPlan", // Phase 5 — plan/usage + shopOwnerEmail (Agency eligibility signal)
  "session",
]);

// Models deliberately NOT deleted, with the reason. Anything in neither
// list fails the schema cross-check test.
export const EXEMPT_MODELS = Object.freeze({});

// ProductMapping and TransferLogEntry have no `shop` column — they hang off
// MigrationJob by jobId. They're deleted via their parent's ids.
const JOB_SCOPED_MODELS = Object.freeze(["transferLogEntry", "productMapping"]);

// Models that identify the shop under different column name(s). Getting this
// wrong is silent: Prisma rejects `where: { shop }` on a model without that
// column, the per-model catch swallows it, and the rows survive erasure —
// which is exactly what happened to TransferSession until a live smoke test
// caught it. TransferSession is a pairing record between two stores, so a
// redact of EITHER side must remove it: it holds both stores' tokens.
const CUSTOM_SHOP_FILTERS = Object.freeze({
  transferSession: (shop) => ({ OR: [{ sourceShop: shop }, { destShop: shop }] }),
});

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

  // Same reasoning for ThemeJob, but the artifacts are on DISK rather than in
  // child tables: each job owns a staging directory of copied theme assets
  // and a packaged ZIP. Both are the merchant's own theme content, so an
  // erasure that only dropped the rows would leave the actual files behind.
  // Collected here, deleted after the rows go — losing the ids first would
  // make the files unreachable.
  let themeJobIds = [];
  try {
    const jobs = await prisma.themeJob.findMany({
      where: { shop },
      select: { id: true, zipId: true, zipToken: true },
    });
    themeJobIds = jobs;
  } catch (err) {
    errors.push({ model: "themeJob(lookup)", error: err?.message || String(err) });
  }

  for (const model of SHOP_SCOPED_MODELS) {
    try {
      // ShopPlan carries a complimentary Pro grant (tier=pro,
      // subscriptionStatus=COMPLIMENTARY) that has NO Shopify AppSubscription
      // behind it — this row is the only record of the grant anywhere. Hard-
      // deleting it on shop/redact silently revokes a deliberate, permanent
      // free grant the moment the merchant reinstalls. So for those rows we
      // erase the personal data (shopOwnerEmail + usage counters) and keep
      // only the non-personal grant state (shop, tier, subscriptionStatus).
      // Every other shop's ShopPlan row is still deleted wholesale below.
      //
      // A failed grant-check falls through to the normal delete: erasing is
      // the fail-safe outcome for a GDPR path.
      if (model === "shopPlan") {
        let grantRetained = false;
        try {
          const plan = await prisma.shopPlan.findUnique({
            where: { shop },
            select: { subscriptionStatus: true },
          });
          if (plan && isComplimentary(plan.subscriptionStatus)) {
            await prisma.shopPlan.update({ where: { shop }, data: { ...SHOPPLAN_PII_FIELDS } });
            deleted[model] = 0;
            deleted["shopPlan(grant retained, PII erased)"] = 1;
            grantRetained = true;
          }
        } catch (err) {
          // Could not check or could not strip PII — fall through to the
          // wholesale delete below. Erasing is the fail-safe for a GDPR path.
          console.warn(`[shop/redact] ${shop}: complimentary-grant check failed, deleting ShopPlan row:`, err?.message);
        }
        if (grantRetained) continue;
      }

      const where = JOB_SCOPED_MODELS.includes(model)
        ? { jobId: { in: jobIds } }
        : (CUSTOM_SHOP_FILTERS[model]?.(shop) ?? { shop });

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

  // On-disk artifacts, after the rows they belong to are gone. Best-effort
  // and non-fatal like every model above: a leftover temp file is a bug worth
  // reporting, but it must not abort an erasure that has already removed the
  // database records.
  let filesRemoved = 0;
  for (const job of themeJobIds) {
    try {
      await clearStagedAssets(job.id);
      await deleteThemeZipNow(job.zipId, job.zipToken);
      filesRemoved += 1;
    } catch (err) {
      errors.push({ model: `themeJob(files:${job.id})`, error: err?.message || String(err) });
    }
  }
  if (themeJobIds.length) deleted["themeJob(files)"] = filesRemoved;

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
