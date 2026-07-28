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
import { runScheduledSyncs } from "../lib/scheduler.server";
import { runMigrationWorker } from "../lib/migration-worker.server";
import { startJobFromSchedule } from "./api.scheduled-sync";

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
      const jobId = await startJobFromSchedule(schedule);
      // Fire-and-forget, exactly like the manual path in api.migration-job.
      runMigrationWorker(jobId).catch((err) =>
        console.error(`[scheduler-tick] worker crash for job=${jobId}:`, err));
      return jobId;
    },
  });

  return Response.json({ ok: !results.error, ...results });
};
