// GET /api/migration-status/:jobId
// Returns current MigrationJob state. Called by the frontend on a polling interval.
// Auto-resumes the worker if the job is RUNNING but the worker died (process restart).

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isWorkerActive, runMigrationWorker } from "../lib/migration-worker.server";
import { fetchJobLog, fetchJobLogSummary } from "../lib/transfer-log.server";
import { describeActor } from "../lib/audit.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const { jobId } = params;
  if (!jobId) return Response.json({ ok: false, error: "Missing jobId" }, { status: 400 });

  const job = await prisma.migrationJob.findUnique({
    where: { id: jobId },
    select: {
      id: true, shop: true, status: true,
      totalProducts: true, processedProducts: true, failedProducts: true,
      lastCursor: true, errorLog: true, conflictMode: true,
      createdAt: true, updatedAt: true,
      // Phase 3.7 audit trail: who triggered this transfer, and from where.
      actorType: true, actorId: true, actorEmail: true, actorIp: true,
    },
  });

  // Ownership check. Authenticating the caller is NOT the same as authorizing
  // them for this job: jobId is a caller-supplied path parameter, so without
  // this any installed shop could poll any other shop's migration by id and
  // read back its product titles, source store domain, per-record error log
  // (including metafield payload snapshots) and the triggering user's email
  // and IP — and, via the auto-resume below, restart another shop's transfer.
  //
  // 404 rather than 403, deliberately: a shop that does not own this job
  // should not be able to tell the difference between "exists, not yours" and
  // "does not exist", which would otherwise make job ids enumerable.
  //
  // Compare api.rollback.jsx and api.backup.jsx, which have always scoped
  // their lookups this way — this endpoint was the one that did not.
  if (!job || job.shop !== session.shop) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
  }

  // Auto-resume: if the job is marked RUNNING but no active worker exists (process restarted),
  // kick off a new worker so the job doesn't stay stuck.
  //
  // PENDING counts too. api.migration-job.jsx creates the row and only then
  // calls the worker, which flips it to RUNNING — so a restart inside that
  // window leaves a job that was never started at all, and testing only for
  // RUNNING meant even a merchant sitting on the progress bar would watch it
  // stay at 0% indefinitely. There is no race with a just-created job:
  // runMigrationWorker registers itself in activeWorkers synchronously, before
  // its first await, so isWorkerActive is already true by the time any poll
  // for that job can arrive.
  //
  // This is still only a recovery path for jobs someone is watching; the
  // scheduler tick covers the ones nobody is (see job-recovery.server.js).
  if ((job.status === "RUNNING" || job.status === "PENDING") && !isWorkerActive(job.id)) {
    console.log(`[api/migration-status] auto-resuming job=${job.id} after process restart`);
    runMigrationWorker(job.id).catch((err) =>
      console.error(`[api/migration-status] auto-resume crash job=${job.id}:`, err),
    );
  }

  let errorLog = [];
  try { errorLog = JSON.parse(job.errorLog || "[]"); } catch { /* ignore */ }

  const pct = job.totalProducts > 0
    ? Math.round((job.processedProducts / job.totalProducts) * 100)
    : 0;

  // Phase 2: granular per-record log. `logSummary` is aggregated in the DB so
  // it stays cheap to poll even for a 50k-record job; `log` returns a page of
  // entries, filterable via ?action=failed&entityType=product&limit=&offset=.
  const url = new URL(request.url);
  const logSummary = await fetchJobLogSummary(prisma, job.id).catch(() => null);
  const log = await fetchJobLog(prisma, job.id, {
    action: url.searchParams.get("action") || undefined,
    entityType: url.searchParams.get("entityType") || undefined,
    limit: url.searchParams.get("limit") || 100,
    offset: url.searchParams.get("offset") || 0,
  }).catch(() => []);

  return Response.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    totalProducts: job.totalProducts,
    processedProducts: job.processedProducts,
    failedProducts: job.failedProducts,
    pct,
    errorLog: errorLog.slice(-50),
    logSummary,
    log,
    // Phase 3.7: who triggered this transfer, when, from which IP.
    triggeredBy: {
      actorType: job.actorType,
      actorId: job.actorId,
      actorEmail: job.actorEmail,
      actorIp: job.actorIp,
      at: job.createdAt,
      description: describeActor(job),
    },
    updatedAt: job.updatedAt,
  });
};
