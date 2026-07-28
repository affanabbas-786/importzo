// GET /api/migration-status/:jobId
// Returns current MigrationJob state. Called by the frontend on a polling interval.
// Auto-resumes the worker if the job is RUNNING but the worker died (process restart).

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isWorkerActive, runMigrationWorker } from "../lib/migration-worker.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const { jobId } = params;
  if (!jobId) return Response.json({ ok: false, error: "Missing jobId" }, { status: 400 });

  const job = await prisma.migrationJob.findUnique({
    where: { id: jobId },
    select: {
      id: true, shop: true, status: true,
      totalProducts: true, processedProducts: true, failedProducts: true,
      lastCursor: true, errorLog: true, conflictMode: true,
      createdAt: true, updatedAt: true,
    },
  });

  if (!job) return Response.json({ ok: false, error: "Job not found" }, { status: 404 });

  // Auto-resume: if the job is marked RUNNING but no active worker exists (process restarted),
  // kick off a new worker so the job doesn't stay stuck.
  if (job.status === "RUNNING" && !isWorkerActive(job.id)) {
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

  return Response.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    totalProducts: job.totalProducts,
    processedProducts: job.processedProducts,
    failedProducts: job.failedProducts,
    pct,
    errorLog: errorLog.slice(-50),
    updatedAt: job.updatedAt,
  });
};
