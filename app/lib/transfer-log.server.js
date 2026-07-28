// ═══════════════════════════════════════════════════════════════════
// Phase 2 — Detailed per-record transfer logs.
//
// Before this, granular history existed only for products, via
// ProductMapping (status DONE|FAILED, no reason for a skip, no record of
// pages/blogs/menus/files/themes/metafields at all). MigrationJob.errorLog
// is a capped JSON summary of *failures only* — useful for the polling API,
// useless for "show me every record and what happened to it".
//
// This module writes one TransferLogEntry per record per entity type, with
// the action taken and the reason. It deliberately does NOT replace
// errorLog — that stays as the small hot summary the status endpoint already
// returns; this is the full queryable history behind it.
// ═══════════════════════════════════════════════════════════════════

export const ACTION = Object.freeze({
  CREATED: "created",
  UPDATED: "updated",
  SKIPPED: "skipped",
  FAILED: "failed",
});

export const ENTITY = Object.freeze({
  PRODUCT: "product",
  COLLECTION: "collection",
  PAGE: "page",
  BLOG: "blog",
  ARTICLE: "article",
  MENU: "menu",
  FILE: "file",
  THEME: "theme",
  METAFIELD: "metafield",
});

// Detail payloads are snapshots for debugging, not archives — cap them so a
// rich-text metafield or a 500-warning batch can't bloat the table.
const MAX_DETAIL_CHARS = 1000;
const MAX_REASON_CHARS = 500;

export function truncate(value, max) {
  if (value === undefined || value === null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Normalizes a caller-supplied entry into exactly the columns the table has,
// so a typo'd extra key can't blow up the createMany call at runtime.
export function normalizeEntry({ jobId, shop, entityType, action, sourceId, destId, title, reason, detail }) {
  if (!jobId) throw new Error("transfer-log: jobId is required");
  if (!entityType) throw new Error("transfer-log: entityType is required");
  if (!Object.values(ACTION).includes(action)) {
    throw new Error(`transfer-log: unknown action "${action}"`);
  }
  return {
    jobId,
    shop: shop || "",
    entityType,
    action,
    sourceId: sourceId != null ? String(sourceId) : null,
    destId: destId != null ? String(destId) : null,
    title: truncate(title, MAX_REASON_CHARS),
    reason: truncate(reason, MAX_REASON_CHARS),
    detail: truncate(detail, MAX_DETAIL_CHARS),
  };
}

// Buffered writer: a 50k-product migration must not issue 50k individual
// INSERTs. Entries accumulate in memory and flush in batches, mirroring the
// existing CHECKPOINT_EVERY pattern in migration-worker.server.js.
//
// Logging is best-effort by design: a logging failure must never fail or
// abort an in-flight transfer, so flush swallows its own errors (and reports
// them via `lastError` for tests/diagnostics).
export function createLogBuffer({ prisma, jobId, shop, flushEvery = 50 }) {
  let pending = [];
  let written = 0;
  let lastError = null;

  async function flush() {
    if (!pending.length) return 0;
    const batch = pending;
    pending = [];
    try {
      await prisma.transferLogEntry.createMany({ data: batch });
      written += batch.length;
      return batch.length;
    } catch (err) {
      lastError = err;
      console.warn(`[transfer-log] failed to write ${batch.length} entries for job=${jobId}:`, err?.message);
      return 0;
    }
  }

  return {
    async add(entry) {
      let normalized;
      try {
        normalized = normalizeEntry({ jobId, shop, ...entry });
      } catch (err) {
        // A malformed entry is a caller bug, not a transfer failure — record
        // and move on rather than taking the migration down with it.
        lastError = err;
        console.warn(`[transfer-log] dropped malformed entry for job=${jobId}:`, err?.message);
        return;
      }
      pending.push(normalized);
      if (pending.length >= flushEvery) await flush();
    },
    flush,
    pendingCount: () => pending.length,
    writtenCount: () => written,
    getLastError: () => lastError,
  };
}

// Aggregate counts for the UI's summary row. Accepts either log entries or
// anything else carrying an `action` field.
export function summarizeLog(entries = []) {
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0, total: 0 };
  for (const e of entries) {
    summary.total++;
    if (e?.action && summary[e.action] !== undefined) summary[e.action]++;
  }
  return summary;
}

// Reads a job's log back out, newest first, with optional filtering.
// `limit` is clamped so a UI bug can't ask for the entire table.
export async function fetchJobLog(prisma, jobId, { action, entityType, limit = 100, offset = 0 } = {}) {
  const where = { jobId };
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return prisma.transferLogEntry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: safeLimit,
    skip: safeOffset,
  });
}

// Counts grouped by action, computed in the DB rather than by loading every
// row — the summary must stay cheap for a 50k-record job.
export async function fetchJobLogSummary(prisma, jobId) {
  const grouped = await prisma.transferLogEntry.groupBy({
    by: ["action"],
    where: { jobId },
    _count: { _all: true },
  });
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0, total: 0 };
  for (const row of grouped) {
    const count = row?._count?._all ?? 0;
    if (summary[row.action] !== undefined) summary[row.action] = count;
    summary.total += count;
  }
  return summary;
}
