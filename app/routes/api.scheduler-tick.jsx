// Phase 2 — Scheduler tick.
//
// POST /api/scheduler-tick   (external cron; e.g. every 15 minutes)
//
// Driven externally rather than by an in-process setInterval, because the app
// runs several PM2 workers and an interval in each would fire the same
// schedule once per worker.
//
// This is the one endpoint that can't use Shopify admin auth (a cron has no
// session), so it's guarded by a shared secret in SCHEDULER_SECRET, compared
// in constant time. With no secret configured the endpoint refuses to run at
// all rather than defaulting open.

import crypto from "crypto";
import prisma from "../db.server";
import { runScheduledSyncs, disableForPlanRequirement } from "../lib/scheduler.server";
import { runMigrationWorker, isWorkerActive } from "../lib/migration-worker.server";
import { recoverOrphanedJobs, recoverOrphanedThemeJobs } from "../lib/job-recovery.server";
import { isWorkerActive as isThemeWorkerActive, runThemeWorker } from "../lib/theme-worker.server";
import { sweepThemeTempFiles } from "../lib/theme-zip.server";
// Imported from lib, not from the sibling route module: importing across
// route files would pull that route's whole module graph in with it.
import { startJobFromSchedule } from "../lib/scheduled-sync.server";
import { getUsageStatus } from "../lib/usage.server";
import { runMaintenance } from "../lib/maintenance.server";

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8"); // eslint-disable-line no-undef
  const bufB = Buffer.from(String(b || ""), "utf8"); // eslint-disable-line no-undef
  // timingSafeEqual throws on length mismatch, which would itself leak length;
  // hash both sides first so the comparison is always over equal-length input.
  const hashA = crypto.createHash("sha256").update(bufA).digest();
  const hashB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const configured = process.env.SCHEDULER_SECRET; // eslint-disable-line no-undef
  if (!configured) {
    console.error("[scheduler-tick] SCHEDULER_SECRET is not set — refusing to run");
    return Response.json({ ok: false, error: "Scheduler is not configured" }, { status: 503 });
  }

  const provided = request.headers?.get?.("x-scheduler-secret") || "";
  if (!timingSafeEqual(provided, configured)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const results = await runScheduledSyncs({
    prisma,
    startJob: async (schedule) => {
      // Phase 5/7 — billing: scheduled sync is Pro/Agency-only. A shop that
      // downgraded after creating a schedule must not keep having it fire —
      // checked here (not just at creation/re-enable time in
      // api.scheduled-sync.jsx) so a downgrade takes effect on the very
      // next tick. Disabled IMMEDIATELY (not via the generic
      // MAX_CONSECUTIVE_FAILURES counter) — a billing-gate failure won't
      // self-heal on retry the way a transient API error might, so waiting
      // out the counter would just leave the schedule silently failing,
      // and the merchant in the dark about why, for several extra days.
      // Still throws afterward so this tick's response reflects the
      // failure and the run is logged — runScheduledSyncs' catch only adds
      // consecutiveFailures/lastError on top for failures <
      // MAX_CONSECUTIVE_FAILURES, so it won't clobber the clear reason or
      // re-enable this just-disabled schedule.
      const planStatus = await getUsageStatus({ prisma, shop: schedule.shop });
      if (!planStatus.scheduledSyncAllowed) {
        const message = `Scheduled sync requires the Pro or Agency plan (currently on ${planStatus.label})`;
        await disableForPlanRequirement(prisma, schedule.id, message);
        throw new Error(message);
      }

      const jobId = await startJobFromSchedule(schedule);
      // Fire-and-forget, exactly like the manual path in api.migration-job.
      runMigrationWorker(jobId).catch((err) =>
        console.error(`[scheduler-tick] worker crash for job=${jobId}:`, err));
      return jobId;
    },
  });

  // Retention housekeeping. This tick is the app's only periodic hook, so it
  // is also where expired backups and expired transfer sessions get deleted —
  // both had a documented retention window that nothing was enforcing. Run
  // after the syncs and folded into the response rather than gating it: a
  // purge failure is worth reporting but must not turn a healthy tick into a
  // cron alert. See maintenance.server.js.
  const maintenance = await runMaintenance({ prisma });

  // Recover migrations orphaned by a process restart. This tick is the app's
  // only periodic server-side hook, which makes it the only place a job with
  // nobody watching it can be picked back up — until now the sole resume path
  // was a merchant actively polling the status endpoint, so a closed tab or a
  // scheduled sync meant a half-finished transfer stayed RUNNING forever.
  // See job-recovery.server.js. Isolated the same way maintenance is: a
  // recovery failure is worth reporting but must not fail the tick.
  const recovery = await recoverOrphanedJobs({
    prisma,
    isActive: isWorkerActive,
    runWorker: (jobId) => runMigrationWorker(jobId),
  }).catch((err) => {
    console.error("[scheduler-tick] job recovery failed:", err?.message);
    return { resumed: [], abandoned: [], skipped: 0, error: String(err?.message || err) };
  });

  // Same recovery, for background THEME transfers. Kept as a separate call
  // rather than folded into the one above because the two run different
  // workers against different tables; sharing the loop (see recoverStale)
  // is what keeps the rules from drifting apart.
  const themeRecovery = await recoverOrphanedThemeJobs({
    prisma,
    isActive: isThemeWorkerActive,
    runWorker: (jobId) => runThemeWorker(jobId),
  }).catch((err) => {
    console.error("[scheduler-tick] theme job recovery failed:", err?.message);
    return { resumed: [], abandoned: [], skipped: 0, error: String(err?.message || err) };
  });

  // Theme staging directories and packaged ZIPs left behind by interrupted
  // transfers. deleteThemeZipLater schedules an unref'd setTimeout that a
  // process restart discards, so without this every killed transfer leaks its
  // assets into tmp permanently.
  const themeTemp = await sweepThemeTempFiles().catch((err) => {
    console.error("[scheduler-tick] theme temp sweep failed:", err?.message);
    return { stageDirs: 0, zips: 0, error: String(err?.message || err) };
  });

  return Response.json({ ok: !results.error, ...results, maintenance, recovery, themeRecovery, themeTemp });
};
