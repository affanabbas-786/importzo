// ═══════════════════════════════════════════════════════════════════
// Phase 2 — Scheduled / recurring sync.
//
// Schedules are advanced by a tick (runScheduledSyncs) driven externally,
// rather than an in-process setInterval: the app runs multiple PM2 workers,
// and an interval in each of them would fire the same schedule N times.
//
// Two failure modes get explicit handling, because both otherwise degrade
// into a silent runaway:
//
//   • Overlap — a sync still running when its next slot arrives. Starting a
//     second job against the same store pair would race with itself, so the
//     slot is skipped and the schedule moves on.
//   • Expiring credentials — offline access tokens expire (see
//     expiringOfflineAccessTokens in shopify.server.js). A schedule that can
//     no longer authenticate would otherwise retry forever, so repeated
//     failures disable it with a reason the merchant can act on.
// ═══════════════════════════════════════════════════════════════════

export const FREQUENCY = Object.freeze({
  HOURLY: "hourly",
  DAILY: "daily",
  WEEKLY: "weekly",
});

// After this many consecutive failures a schedule disables itself rather than
// hammering a store it can't authenticate against.
export const MAX_CONSECUTIVE_FAILURES = 3;

export function isValidFrequency(frequency) {
  return Object.values(FREQUENCY).includes(frequency);
}

// Pure next-run calculation, always strictly in the future relative to `from`
// so a due schedule can never compute a slot that is already past and
// re-fire immediately.
export function computeNextRun(schedule, from = new Date()) {
  const frequency = schedule?.frequency || FREQUENCY.DAILY;
  const hourUtc = Number.isInteger(schedule?.hourUtc) ? schedule.hourUtc : 3;
  const base = new Date(from.getTime());

  if (frequency === FREQUENCY.HOURLY) {
    const next = new Date(base);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }

  if (frequency === FREQUENCY.WEEKLY) {
    const targetDay = Number.isInteger(schedule?.dayOfWeek) ? schedule.dayOfWeek : 0;
    const next = new Date(base);
    next.setUTCHours(hourUtc, 0, 0, 0);
    let deltaDays = (targetDay - next.getUTCDay() + 7) % 7;
    if (deltaDays === 0 && next.getTime() <= base.getTime()) deltaDays = 7;
    next.setUTCDate(next.getUTCDate() + deltaDays);
    return next;
  }

  // Daily (default).
  const next = new Date(base);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= base.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function findDueSchedules(prisma, now = new Date(), limit = 25) {
  return prisma.scheduledSync.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: limit,
  });
}

// True when the schedule's previous job hasn't finished. Starting another run
// against the same store pair would have two workers writing concurrently.
export async function hasRunInFlight(prisma, schedule) {
  if (!schedule?.lastJobId) return false;
  const job = await prisma.migrationJob.findUnique({ where: { id: schedule.lastJobId } });
  if (!job) return false;
  return job.status === "RUNNING" || job.status === "PENDING";
}

// Runs every due schedule. `startJob` is injected so this stays testable
// without a live Shopify or a real worker; it receives the schedule and
// returns the created job id.
//
// Never throws: one broken schedule must not stop the rest of the tick.
export async function runScheduledSyncs({ prisma, startJob, now = () => new Date(), limit = 25 }) {
  const at = now();
  const results = { ran: [], skipped: [], failed: [], disabled: [] };

  let due = [];
  try {
    due = await findDueSchedules(prisma, at, limit);
  } catch (err) {
    console.error("[scheduler] could not load due schedules:", err?.message);
    return { ...results, error: err?.message || String(err) };
  }

  for (const schedule of due) {
    try {
      if (await hasRunInFlight(prisma, schedule)) {
        // Skip this slot rather than queueing a concurrent run; move the
        // schedule forward so it isn't re-examined on every tick.
        const nextRunAt = computeNextRun(schedule, at);
        await prisma.scheduledSync.update({ where: { id: schedule.id }, data: { nextRunAt } });
        results.skipped.push({ id: schedule.id, reason: "Previous run is still in progress", nextRunAt });
        continue;
      }

      const jobId = await startJob(schedule);
      const nextRunAt = computeNextRun(schedule, at);
      await prisma.scheduledSync.update({
        where: { id: schedule.id },
        data: { lastRunAt: at, lastJobId: jobId, nextRunAt, consecutiveFailures: 0, lastError: null },
      });
      results.ran.push({ id: schedule.id, jobId, nextRunAt });
    } catch (err) {
      const message = err?.message || String(err);
      const failures = (schedule.consecutiveFailures || 0) + 1;
      console.warn(`[scheduler] schedule ${schedule.id} failed (${failures}/${MAX_CONSECUTIVE_FAILURES}):`, message);

      try {
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          const reason = `Disabled after ${failures} consecutive failures. Last error: ${message}`;
          await prisma.scheduledSync.update({
            where: { id: schedule.id },
            data: { consecutiveFailures: failures, enabled: false, disabledReason: reason, lastError: message },
          });
          results.disabled.push({ id: schedule.id, reason });
        } else {
          await prisma.scheduledSync.update({
            where: { id: schedule.id },
            data: { consecutiveFailures: failures, lastError: message, nextRunAt: computeNextRun(schedule, at) },
          });
          results.failed.push({ id: schedule.id, error: message, attempt: failures });
        }
      } catch (writeErr) {
        console.error(`[scheduler] could not record failure for schedule ${schedule.id}:`, writeErr?.message);
        results.failed.push({ id: schedule.id, error: message, attempt: failures });
      }
    }
  }

  return results;
}

// Immediately disables a schedule whose credentials no longer work. Callers
// that detect a 401/403 during a run should use this rather than waiting for
// the failure counter — an expired token will never fix itself.
export async function disableForAuthFailure(prisma, scheduleId, detail = "") {
  const reason = `Disabled because the stored access token is no longer valid. Reconnect the source store to re-enable.${detail ? ` (${detail})` : ""}`;
  await prisma.scheduledSync.update({
    where: { id: scheduleId },
    data: { enabled: false, disabledReason: reason, lastError: reason },
  });
  return reason;
}

// Billing audit (Phase 7) — same reasoning as disableForAuthFailure: a plan
// downgrade below the tier that includes scheduled sync will never "fix
// itself" on retry the way a transient API error might, so waiting for
// MAX_CONSECUTIVE_FAILURES before disabling just leaves a schedule silently
// failing (and the merchant in the dark about why) for up to that many
// extra ticks — for a daily schedule, up to that many extra days. Callers
// that detect the plan-gate has failed should disable immediately instead.
export async function disableForPlanRequirement(prisma, scheduleId, message) {
  await prisma.scheduledSync.update({
    where: { id: scheduleId },
    data: { enabled: false, disabledReason: message, lastError: message },
  });
  return message;
}

export function isAuthError(error) {
  const message = String(error?.message || error || "");
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid.*token|token.*(expired|invalid)/i.test(message);
}
