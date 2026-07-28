// ═══════════════════════════════════════════════════════════════════
// Phase 2 — Rollback: undo a transfer within a time window.
//
// This is the most destructive operation in the app, so its rules are
// deliberately conservative. Rollback deletes ONLY destination products this
// transfer can prove it created:
//
//   • action "created" → delete. We made it; removing it restores the prior state.
//   • action "skipped" → NEVER delete. The handle already existed, so this row
//     points at the MERCHANT'S OWN product that the transfer left alone.
//     Deleting it would destroy data the transfer never touched.
//   • action "updated" → NEVER delete. It pre-existed and was overwritten;
//     the way back is restoring its old field values from the pre-transfer
//     backup (backup.server.js), not deleting the product.
//   • action "unknown" → NEVER delete. Written before ProductMapping.action
//     existed; we cannot prove we created it, so we must assume we didn't.
//
// Rollback and restore are complementary halves of a full undo: rollback
// removes what was created, restore reverts what was overwritten.
// ═══════════════════════════════════════════════════════════════════

import { ACTION, ENTITY } from "./transfer-log.server.js";

export const DEFAULT_ROLLBACK_WINDOW_HOURS = 24;

// Only this action may ever be deleted. Kept as a single source of truth so
// the plan and the execution can't drift apart.
export const DELETABLE_ACTION = "created";

export const NON_DELETABLE_REASON = Object.freeze({
  skipped: "Skipped during the transfer — this is a pre-existing product on the destination, not one this transfer created",
  updated: "Overwritten during the transfer — restore the pre-transfer backup to revert its values instead of deleting it",
  unknown: "Recorded before rollback tracking existed — this transfer cannot prove it created this product, so it will not be deleted",
});

const PRODUCT_DELETE_MUTATION = `#graphql
  mutation RollbackDeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }`;

export function rollbackDeadline(job, windowHours = DEFAULT_ROLLBACK_WINDOW_HOURS) {
  const startedAt = job?.updatedAt || job?.createdAt;
  if (!startedAt) return null;
  return new Date(new Date(startedAt).getTime() + windowHours * 60 * 60 * 1000);
}

export function isWithinRollbackWindow(job, now = new Date(), windowHours = DEFAULT_ROLLBACK_WINDOW_HOURS) {
  const deadline = rollbackDeadline(job, windowHours);
  if (!deadline) return false;
  return now.getTime() <= deadline.getTime();
}

// Checks every precondition without touching the store. Returned as a list so
// the UI can explain all the reasons at once instead of one at a time.
export function checkRollbackEligibility(job, { now = new Date(), windowHours = DEFAULT_ROLLBACK_WINDOW_HOURS, shop } = {}) {
  const blockers = [];

  if (!job) return { eligible: false, blockers: ["Job not found"] };
  if (shop && job.shop !== shop) return { eligible: false, blockers: ["Job not found"] };
  if (job.rolledBackAt) blockers.push("This transfer has already been rolled back");
  if (job.status === "RUNNING" || job.status === "PENDING") {
    blockers.push("This transfer is still running — wait for it to finish before rolling back");
  }
  if (!isWithinRollbackWindow(job, now, windowHours)) {
    const deadline = rollbackDeadline(job, windowHours);
    blockers.push(`The ${windowHours}-hour rollback window closed${deadline ? ` at ${deadline.toISOString()}` : ""}`);
  }

  return { eligible: blockers.length === 0, blockers, deadline: rollbackDeadline(job, windowHours) };
}

// Splits a job's mappings into what rollback would delete vs. deliberately
// preserve, each with a reason. Read-only — this is what a confirmation
// screen should show BEFORE anything is deleted.
export function planRollback(mappings = []) {
  const deletable = [];
  const preserved = [];

  for (const m of mappings) {
    if (m.status !== "DONE" || !m.destProductId) {
      preserved.push({ ...m, reason: "No destination product was created for this record" });
      continue;
    }
    if (m.action === DELETABLE_ACTION) {
      deletable.push(m);
    } else {
      preserved.push({ ...m, reason: NON_DELETABLE_REASON[m.action] || NON_DELETABLE_REASON.unknown });
    }
  }

  return {
    deletable,
    preserved,
    summary: { willDelete: deletable.length, willPreserve: preserved.length, total: mappings.length },
  };
}

export async function getRollbackPlan(prisma, jobId, options = {}) {
  const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
  const eligibility = checkRollbackEligibility(job, options);
  if (!job) return { ...eligibility, plan: null, job: null };

  const mappings = await prisma.productMapping.findMany({ where: { jobId } });
  return { ...eligibility, job, plan: planRollback(mappings) };
}

// Executes the rollback. Deletes only what planRollback marked deletable.
// Never throws for a per-product failure — a product deleted manually since
// the transfer shouldn't abort the rest of the undo.
export async function rollbackJob({
  prisma, shopifyGraphql, jobId, token, version,
  now = () => new Date(), windowHours = DEFAULT_ROLLBACK_WINDOW_HOURS,
  shop, logBuffer = null, deleteConcurrency = 5,
}) {
  const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
  const eligibility = checkRollbackEligibility(job, { now: now(), windowHours, shop });
  if (!eligibility.eligible) {
    return { ok: false, deleted: 0, failed: 0, preserved: 0, blockers: eligibility.blockers, errors: [] };
  }

  const mappings = await prisma.productMapping.findMany({ where: { jobId } });
  const { deletable, preserved } = planRollback(mappings);

  const result = { ok: true, deleted: 0, failed: 0, preserved: preserved.length, blockers: [], errors: [] };

  // Bounded concurrency, mirroring the worker's CREATE_CONCURRENCY.
  for (let i = 0; i < deletable.length; i += deleteConcurrency) {
    const slice = deletable.slice(i, i + deleteConcurrency);
    await Promise.all(slice.map(async (mapping) => {
      const gid = `gid://shopify/Product/${mapping.destProductId}`;
      try {
        const data = await shopifyGraphql(job.shop, token, PRODUCT_DELETE_MUTATION, { input: { id: gid } }, version);
        const userErrors = data?.productDelete?.userErrors || [];
        if (userErrors.length) {
          const reason = userErrors.map((e) => e.message).join("; ");
          result.failed++;
          result.errors.push({ destProductId: mapping.destProductId, error: reason });
          await logBuffer?.add({ entityType: ENTITY.PRODUCT, action: ACTION.FAILED, sourceId: mapping.sourceProductId, destId: mapping.destProductId, reason: `Rollback delete failed: ${reason}` });
          return;
        }
        result.deleted++;
        await logBuffer?.add({ entityType: ENTITY.PRODUCT, action: ACTION.SKIPPED, sourceId: mapping.sourceProductId, destId: mapping.destProductId, reason: "Deleted by rollback" });
      } catch (err) {
        result.failed++;
        result.errors.push({ destProductId: mapping.destProductId, error: err?.message || String(err) });
        await logBuffer?.add({ entityType: ENTITY.PRODUCT, action: ACTION.FAILED, sourceId: mapping.sourceProductId, destId: mapping.destProductId, reason: `Rollback delete failed: ${err?.message}` });
      }
    }));
  }

  await logBuffer?.flush();

  // Stamped even on partial failure: the transfer HAS been rolled back, and
  // re-running it would try to delete products that are already gone.
  // Remaining failures are reported in `errors` for manual follow-up.
  try {
    await prisma.migrationJob.update({ where: { id: jobId }, data: { rolledBackAt: now() } });
  } catch (err) {
    console.warn(`[rollback] could not stamp rolledBackAt on job ${jobId}:`, err?.message);
  }

  result.ok = result.failed === 0;
  return result;
}
