// Phase 2 — Rollback API: undo a transfer within its time window.
//
// GET  /api/rollback?jobId=          → the plan: what WOULD be deleted vs preserved, and why
// POST /api/rollback intent=rollback → execute it
//
// The GET is deliberately a separate, read-only step: this is the most
// destructive operation in the app, and a confirmation screen should be able
// to show exactly what it will and won't touch before anyone commits.
//
// Everything is scoped to the authenticated shop, and another shop's job is
// reported as "Job not found" rather than forbidden, so job ids can't be probed.

import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { getRollbackPlan, rollbackJob, DEFAULT_ROLLBACK_WINDOW_HOURS } from "../lib/rollback.server";
import { createLogBuffer } from "../lib/transfer-log.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return Response.json({ ok: false, error: "Missing jobId" }, { status: 400 });

  const { eligible, blockers, deadline, plan, job } = await getRollbackPlan(prisma, jobId, {
    shop: session.shop,
    windowHours: DEFAULT_ROLLBACK_WINDOW_HOURS,
  });

  // A job belonging to another shop must be indistinguishable from one that
  // doesn't exist — returning its plan would leak that the id is real, plus
  // the destination product ids inside it.
  if (!job || job.shop !== session.shop) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
  }

  return Response.json({
    ok: true,
    jobId,
    eligible,
    blockers,
    deadline,
    windowHours: DEFAULT_ROLLBACK_WINDOW_HOURS,
    summary: plan?.summary || null,
    // Capped for transport — the summary always covers the full set.
    willDelete: (plan?.deletable || []).slice(0, 200).map((m) => ({
      sourceProductId: m.sourceProductId, destProductId: m.destProductId,
    })),
    willPreserve: (plan?.preserved || []).slice(0, 200).map((m) => ({
      sourceProductId: m.sourceProductId, destProductId: m.destProductId, action: m.action, reason: m.reason,
    })),
    backupId: job.backupId || null,
    rolledBackAt: job.rolledBackAt || null,
  });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "rollback") {
    return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
  }

  const jobId = (formData.get("jobId") || "").trim();
  if (!jobId) return Response.json({ ok: false, error: "Missing jobId" }, { status: 400 });

  const logBuffer = createLogBuffer({ prisma, jobId, shop: session.shop });

  const result = await rollbackJob({
    prisma, shopifyGraphql, jobId,
    token: session.accessToken,
    version: apiVersion || "2025-10",
    shop: session.shop,
    logBuffer,
  });

  // Blockers mean nothing was attempted — that's a client-side precondition
  // failure, distinct from a rollback that ran and partially failed.
  if (result.blockers?.length) {
    return Response.json({ ok: false, blockers: result.blockers, deleted: 0, failed: 0, preserved: 0 }, { status: 409 });
  }

  return Response.json({
    ok: result.ok,
    deleted: result.deleted,
    failed: result.failed,
    preserved: result.preserved,
    errors: (result.errors || []).slice(0, 50),
  });
};
