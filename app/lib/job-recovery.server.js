// ═══════════════════════════════════════════════════════════════════
// Server-side recovery for migration jobs orphaned by a process restart.
//
// THE GAP THIS EXISTS TO FIX
//
// runMigrationWorker is fire-and-forget: it lives in the Node event loop,
// not in a request. When PM2 restarts the app (a deploy, an OOM, a crash,
// `max_restarts` doing its job) every in-flight worker dies instantly, while
// the MigrationJob row it was driving stays at status=RUNNING forever.
//
// The ONLY thing that ever restarted such a job was
// api.migration-status.$jobId.jsx's auto-resume — which requires a merchant
// to be actively polling that job. That is a real recovery path for the
// merchant who is watching the progress bar when the restart happens, and no
// recovery path at all for anyone else:
//
//   • A merchant who starts a 50k-product migration and closes the tab (the
//     whole reason this app has a background worker) never polls again.
//   • A scheduled sync has no browser behind it, ever. Its job is created by
//     the cron tick and polled by nobody.
//   • A merchant who does come back gets a progress bar frozen at whatever
//     percentage it reached, with no error, because the job genuinely is
//     still marked RUNNING.
//
// In every one of those cases the destination store is left half-migrated
// and the app reports the transfer as still in progress. Silence is the
// worst possible outcome for this app's core operation.
//
// PENDING has the same hole one step earlier: api.migration-job.jsx creates
// the row and then calls the worker, so a restart in that window leaves a job
// that was never started at all — and the status endpoint's auto-resume only
// ever looked at RUNNING, so nothing would pick it up even with a merchant
// watching.
//
// THE FIX
//
// The scheduler tick (api.scheduler-tick.jsx, every 15 minutes from cron) is
// the app's only periodic server-side hook. Resuming from there means
// recovery no longer depends on anyone having a browser open.
//
// SAFETY
//
// Resuming is safe precisely because the worker is already built to be
// resumed — the status endpoint has been doing it since the worker shipped.
// It reads lastCursor and the ProductMapping rows marked DONE and skips
// everything already transferred, and it deliberately does not re-snapshot a
// backup for a job that already has one. Recovery adds no new assumption; it
// only adds a caller that isn't a browser.
// ═══════════════════════════════════════════════════════════════════

// A healthy RUNNING worker touches its row constantly — a checkpoint every 50
// products, plus a lastCursor write per 250-product page. Going quiet for this
// long means the process it was running in is gone. Generous rather than tight
// because the one legitimately slow, silent step is the pre-transfer backup of
// a large destination store, and re-entering a job that is actually alive
// would be worse than waiting another tick.
export const RUNNING_STALE_MS = 15 * 60 * 1000;

// PENDING is a much narrower window — the worker flips it to RUNNING within
// milliseconds of being called — so anything still PENDING after this was
// never started.
export const PENDING_STALE_MS = 5 * 60 * 1000;

// Past this age a job stops being resumed and is failed instead. Without it, a
// job that reliably kills the process (or one whose store was disconnected
// months ago) would be retried by every tick, forever. Failing it is also what
// finally tells the merchant something went wrong, instead of leaving a
// progress bar frozen at RUNNING indefinitely.
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

// Ceiling on workers started by a single tick. A restart during a busy period
// could orphan many jobs at once, and resuming all of them simultaneously
// would recreate the load spike that the per-shop concurrency cap in
// api.migration-job.jsx exists to prevent.
export const MAX_RESUMES_PER_TICK = 3;

export const ABANDON_MESSAGE =
  "This transfer was interrupted (the server restarted) and could not be resumed within 24 hours, " +
  "so it has been marked failed. Nothing already transferred was removed — start a new transfer with " +
  'conflict handling set to "skip" to continue from where this one stopped.';

/**
 * Finds and restarts migration jobs whose worker died with the process.
 *
 * `isActive` and `runWorker` are injected so this is testable without the
 * worker's module-level registry, and so the caller (the route) owns the
 * import of migration-worker.server.js rather than this module pulling Prisma
 * and the whole worker graph into every test that touches it.
 *
 * Never throws: recovery failing must not turn a healthy scheduler tick into
 * a cron alert, exactly like runMaintenance alongside it.
 */
export async function recoverOrphanedJobs({
  prisma,
  isActive,
  runWorker,
  now = new Date(),
  limit = MAX_RESUMES_PER_TICK,
} = {}) {
  const result = { resumed: [], abandoned: [], skipped: 0 };

  let candidates;
  try {
    candidates = await prisma.migrationJob.findMany({
      where: {
        status: { in: ["RUNNING", "PENDING"] },
        updatedAt: { lt: new Date(now.getTime() - PENDING_STALE_MS) },
      },
      orderBy: { updatedAt: "asc" },
      select: { id: true, shop: true, status: true, createdAt: true, updatedAt: true },
    });
  } catch (err) {
    console.error("[job-recovery] could not load in-flight jobs:", err?.message);
    return { ...result, error: err?.message || String(err) };
  }

  for (const job of candidates) {
    // Still being worked in THIS process — the row is simply between writes.
    // Checked before the staleness thresholds so a live job can never be
    // double-started, whatever its timestamps look like.
    if (isActive(job.id)) {
      result.skipped += 1;
      continue;
    }

    const quietFor = now.getTime() - new Date(job.updatedAt).getTime();
    const threshold = job.status === "RUNNING" ? RUNNING_STALE_MS : PENDING_STALE_MS;
    if (quietFor < threshold) {
      result.skipped += 1;
      continue;
    }

    // Too old to keep retrying — fail it so the merchant is told, rather than
    // resuming it on every tick until the end of time.
    if (now.getTime() - new Date(job.createdAt).getTime() > ABANDON_AFTER_MS) {
      try {
        await prisma.migrationJob.update({
          where: { id: job.id },
          data: { status: "FAILED", errorLog: JSON.stringify([{ type: "interrupted", error: ABANDON_MESSAGE }]) },
        });
        console.warn(`[job-recovery] job=${job.id} ABANDONED after 24h of interruption (shop=${job.shop})`);
        result.abandoned.push({ id: job.id, shop: job.shop });
      } catch (err) {
        console.error(`[job-recovery] could not abandon job=${job.id}:`, err?.message);
      }
      continue;
    }

    if (result.resumed.length >= limit) {
      result.skipped += 1;
      continue;
    }

    // Fire-and-forget, exactly like every other caller of the worker. A crash
    // inside it must not take down the scheduler tick.
    try {
      console.log(
        `[job-recovery] resuming job=${job.id} (shop=${job.shop}, status=${job.status}, ` +
        `quiet for ${Math.round(quietFor / 60000)}m) — no worker is running it`,
      );
      runWorker(job.id).catch((err) =>
        console.error(`[job-recovery] resumed worker crashed for job=${job.id}:`, err));
      result.resumed.push({ id: job.id, shop: job.shop, status: job.status });
    } catch (err) {
      console.error(`[job-recovery] could not resume job=${job.id}:`, err?.message);
    }
  }

  return result;
}
