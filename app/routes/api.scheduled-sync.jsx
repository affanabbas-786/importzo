// Phase 2 — Scheduled sync management (merchant-facing CRUD).
//
// GET  /api/scheduled-sync                    → this shop's schedules
// POST /api/scheduled-sync intent=create      → create one
// POST /api/scheduled-sync intent=update      → enable/disable, change cadence
// POST /api/scheduled-sync intent=delete      → remove one
//
// Tokens are encrypted at rest here, and never returned by any handler —
// the whole point of a recurring sync is that credentials outlive the
// session, so they must not leak back out through the management surface.

import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import { getSavedSourceStore } from "../lib/safe-db";
import { computeNextRun, isValidFrequency, FREQUENCY } from "../lib/scheduler.server";

// Never select the token columns — see note above.
const SAFE_FIELDS = {
  id: true, shop: true, sourceShop: true, frequency: true, hourUtc: true,
  dayOfWeek: true, conflictMode: true, enabled: true, nextRunAt: true,
  lastRunAt: true, lastJobId: true, lastError: true,
  consecutiveFailures: true, disabledReason: true, createdAt: true, updatedAt: true,
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const schedules = await prisma.scheduledSync.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    select: SAFE_FIELDS,
  });
  return Response.json({ ok: true, schedules });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const frequency = (formData.get("frequency") || FREQUENCY.DAILY).trim();
    if (!isValidFrequency(frequency)) {
      return Response.json({ ok: false, error: `Unsupported frequency "${frequency}"` }, { status: 400 });
    }

    const hourUtc = Number.parseInt(formData.get("hourUtc") ?? "3", 10);
    if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
      return Response.json({ ok: false, error: "hourUtc must be an integer between 0 and 23" }, { status: 400 });
    }

    let dayOfWeek = null;
    if (frequency === FREQUENCY.WEEKLY) {
      dayOfWeek = Number.parseInt(formData.get("dayOfWeek") ?? "0", 10);
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return Response.json({ ok: false, error: "dayOfWeek must be an integer between 0 (Sunday) and 6" }, { status: 400 });
      }
    }

    // Resolve source credentials the same way a manual transfer does.
    let sourceShop = (formData.get("sourceShop") || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    let sourceToken = (formData.get("sourceToken") || "").trim();
    if (!sourceShop || !sourceToken) {
      const saved = await getSavedSourceStore(session.shop);
      if (saved) { sourceShop = saved.sourceUrl; sourceToken = saved.token; }
    }
    if (!sourceShop || !sourceToken) {
      return Response.json({ ok: false, error: "Missing source store credentials" }, { status: 400 });
    }
    if (!sourceShop.includes(".")) sourceShop = `${sourceShop}.myshopify.com`;

    const draft = { frequency, hourUtc, dayOfWeek };
    const created = await prisma.scheduledSync.create({
      data: {
        shop: session.shop,
        sourceShop,
        sourceToken: encrypt(sourceToken),
        destToken: encrypt(session.accessToken),
        frequency,
        hourUtc,
        dayOfWeek,
        conflictMode: (formData.get("conflictMode") || "skip").trim(),
        enabled: true,
        nextRunAt: computeNextRun(draft, new Date()),
      },
      select: SAFE_FIELDS,
    });

    return Response.json({ ok: true, schedule: created });
  }

  if (intent === "update") {
    const id = (formData.get("id") || "").trim();
    if (!id) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });

    const existing = await prisma.scheduledSync.findUnique({ where: { id } });
    // Another shop's schedule is reported as missing, not forbidden.
    if (!existing || existing.shop !== session.shop) {
      return Response.json({ ok: false, error: "Schedule not found" }, { status: 404 });
    }

    const data = {};

    if (formData.has("enabled")) {
      const enabled = formData.get("enabled") === "true";
      data.enabled = enabled;
      if (enabled) {
        // Re-enabling clears the disable state and the failure streak —
        // otherwise one more failure would immediately disable it again.
        data.disabledReason = null;
        data.consecutiveFailures = 0;
        data.lastError = null;
        // Refresh the stored destination token: a schedule is usually
        // disabled because credentials expired, and the current session
        // carries a working one.
        data.destToken = encrypt(session.accessToken);
      }
    }

    if (formData.has("frequency")) {
      const frequency = (formData.get("frequency") || "").trim();
      if (!isValidFrequency(frequency)) {
        return Response.json({ ok: false, error: `Unsupported frequency "${frequency}"` }, { status: 400 });
      }
      data.frequency = frequency;
    }

    if (formData.has("hourUtc")) {
      const hourUtc = Number.parseInt(formData.get("hourUtc"), 10);
      if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
        return Response.json({ ok: false, error: "hourUtc must be an integer between 0 and 23" }, { status: 400 });
      }
      data.hourUtc = hourUtc;
    }

    if (formData.has("dayOfWeek")) {
      const dayOfWeek = Number.parseInt(formData.get("dayOfWeek"), 10);
      if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return Response.json({ ok: false, error: "dayOfWeek must be an integer between 0 (Sunday) and 6" }, { status: 400 });
      }
      data.dayOfWeek = dayOfWeek;
    }

    if (formData.has("conflictMode")) data.conflictMode = (formData.get("conflictMode") || "skip").trim();

    // Any cadence change invalidates the previously computed slot.
    if (data.frequency || data.hourUtc !== undefined || data.dayOfWeek !== undefined || data.enabled === true) {
      data.nextRunAt = computeNextRun({ ...existing, ...data }, new Date());
    }

    const updated = await prisma.scheduledSync.update({ where: { id }, data, select: SAFE_FIELDS });
    return Response.json({ ok: true, schedule: updated });
  }

  if (intent === "delete") {
    const id = (formData.get("id") || "").trim();
    if (!id) return Response.json({ ok: false, error: "Missing id" }, { status: 400 });

    // deleteMany scoped by shop: a non-matching id deletes nothing rather
    // than erroring, and can't be used to probe another shop's ids.
    const { count } = await prisma.scheduledSync.deleteMany({ where: { id, shop: session.shop } });
    if (!count) return Response.json({ ok: false, error: "Schedule not found" }, { status: 404 });
    return Response.json({ ok: true, deleted: count });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
};

// Exported for the tick route: turns a schedule into a running MigrationJob.
export async function startJobFromSchedule(schedule) {
  const job = await prisma.migrationJob.create({
    data: {
      shop: schedule.shop,
      sourceShop: schedule.sourceShop,
      // Stored encrypted on the schedule; MigrationJob stores its own
      // encrypted copy, so decrypt and re-encrypt rather than assuming the
      // two models will always share an encryption scheme.
      sourceToken: encrypt(decrypt(schedule.sourceToken)),
      destToken: encrypt(decrypt(schedule.destToken)),
      apiVersion: apiVersion || "2025-10",
      conflictMode: schedule.conflictMode || "skip",
      status: "PENDING",
    },
  });
  return job.id;
}
