// GET /api/theme-status/:jobId
// Current ThemeJob state, polled by the Transfer page.
// Auto-resumes the worker if the job is live but its worker died.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isWorkerActive, runThemeWorker, PHASE } from "../lib/theme-worker.server";
import { describeActor } from "../lib/audit.server";

// Merchant-facing copy per phase. Only FETCHING has a real denominator, so
// only FETCHING gets a percentage — inventing one for the other five would
// recreate exactly the problem the message carousel had, a progress
// indicator that doesn't correspond to progress.
const PHASE_COPY = Object.freeze({
  [PHASE.LISTING]: "Reading theme files from source…",
  [PHASE.FETCHING]: "Copying theme files",
  [PHASE.PACKAGING]: "Packaging theme files…",
  [PHASE.MEDIA]: "Uploading referenced images…",
  [PHASE.CREATING]: "Creating theme on destination…",
  [PHASE.EXTRACTING]: "Shopify is unpacking the theme…",
});

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const { jobId } = params;
  if (!jobId) return Response.json({ ok: false, error: "Missing jobId" }, { status: 400 });

  const job = await prisma.themeJob.findUnique({ where: { id: jobId } });

  // Ownership check. Authenticating the caller is not the same as
  // authorizing them for this job: jobId is caller-supplied. 404 rather than
  // 403 deliberately — a shop that doesn't own this job must not be able to
  // tell "exists, not yours" from "doesn't exist", which would make ids
  // enumerable. Same reasoning as api.migration-status.$jobId.jsx.
  if (!job || job.shop !== session.shop) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
  }

  // Auto-resume for a job someone is actively watching. PENDING is included
  // because the row is created before the worker is called, so a restart in
  // that window otherwise strands the job at 0% forever. No race with a
  // just-created job: runThemeWorker registers itself synchronously before
  // its first await. Jobs nobody is watching are covered by the scheduler
  // tick — see job-recovery.server.js.
  if ((job.status === "RUNNING" || job.status === "PENDING") && !isWorkerActive(job.id)) {
    console.log(`[api/theme-status] auto-resuming job=${job.id} at phase=${job.phase}`);
    runThemeWorker(job.id).catch((err) =>
      console.error(`[api/theme-status] auto-resume crash job=${job.id}:`, err),
    );
  }

  let errorLog = [];
  try { errorLog = JSON.parse(job.errorLog || "[]"); } catch { /* ignore */ }

  const isFetching = job.phase === PHASE.FETCHING;
  const pct = isFetching && job.assetsTotal > 0
    ? Math.round((job.assetsFetched / job.assetsTotal) * 100)
    : null;

  const message = isFetching && job.assetsTotal > 0
    ? `${PHASE_COPY[PHASE.FETCHING]}: ${job.assetsFetched.toLocaleString()} / ${job.assetsTotal.toLocaleString()} (${pct}%)`
    : (PHASE_COPY[job.phase] || "Transferring theme…");

  const shopHandle = job.shop.replace(/\.myshopify\.com$/i, "");

  return Response.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    message,
    pct,
    assetsTotal: job.assetsTotal,
    assetsFetched: job.assetsFetched,
    assetsFailed: job.assetsFailed,
    themeName: job.sourceThemeName,
    newThemeName: job.targetThemeName,
    newThemeId: job.newThemeId,
    previewUrl: job.newThemeId ? `https://${job.shop}/?preview_theme_id=${job.newThemeId}` : null,
    destinationAdminUrl: `https://${shopHandle}.myshopify.com/admin/themes`,
    errorLog: errorLog.slice(-50),
    triggeredBy: {
      actorType: job.actorType,
      actorId: job.actorId,
      actorEmail: job.actorEmail,
      actorIp: job.actorIp,
      at: job.createdAt,
      description: describeActor(job),
    },
    updatedAt: job.updatedAt,
  }, { headers: { "Cache-Control": "no-store" } });
};
