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
import { runMigrationWorker } from "../lib/migration-worker.server";
// Imported from lib, not from the sibling route module: importing across
// route files would pull that route's whole module graph in with it.
import { startJobFromSchedule } from "../lib/scheduled-sync.server";
import { getUsageStatus } from "../lib/usage.server";

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

  return Response.json({ ok: !results.error, ...results });
};
