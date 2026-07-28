// Phase 2 — Backup management API.
//
// GET  /api/backup?jobId=            → list this shop's backups (newest first)
// POST /api/backup  intent=restore   → one-click restore of a backup
// POST /api/backup  intent=create    → take an on-demand snapshot
//
// Every handler is scoped to the authenticated shop: a backup belonging to
// another shop is treated as not-found rather than 403, so this endpoint can't
// be used to probe whether another store's backup id exists.

import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyGraphql } from "../lib/shopify-api.server";
import { createBackup, restoreBackup } from "../lib/backup.server";
import { withPolicy } from "../lib/rate-limit.server";
import { createLogBuffer } from "../lib/transfer-log.server";
import { actorFromSession, describeActor } from "../lib/audit.server";

const LIST_LIMIT = 50;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");

  const backups = await prisma.storeBackup.findMany({
    where: { shop: session.shop, ...(jobId ? { jobId } : {}) },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    // `data` is the whole snapshot payload — never send it in a list view.
    select: {
      id: true, shop: true, jobId: true, status: true,
      productCount: true, collectionCount: true, metafieldCount: true,
      truncated: true, sizeBytes: true, error: true,
      createdAt: true, expiresAt: true, restoredAt: true,
    },
  });

  return Response.json({ ok: true, backups });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const version = apiVersion || "2025-10";

  if (intent === "create") {
    // Snapshots the entire destination catalog — capped at one at a time
    // per shop so a click-happy merchant can't saturate the shared VPS.
    return withPolicy({ policyName: "backup", shop: session.shop }, async () => {
      const result = await createBackup({
        prisma, shopifyGraphql,
        shop: session.shop, token: session.accessToken, version,
        jobId: formData.get("jobId") || null,
      });
      if (!result.ok) {
        return Response.json({ ok: false, error: result.error, backupId: result.backup?.id || null }, { status: 502 });
      }
      return Response.json({
        ok: true,
        backupId: result.backup.id,
        status: result.backup.status,
        truncated: result.truncated,
        productCount: result.backup.productCount,
        collectionCount: result.backup.collectionCount,
      });
    });
  }

  if (intent === "restore") {
    const backupId = (formData.get("backupId") || "").trim();
    if (!backupId) return Response.json({ ok: false, error: "Missing backupId" }, { status: 400 });

    const backup = await prisma.storeBackup.findUnique({ where: { id: backupId } });
    // Scope to the authenticated shop — a backup from another store must not
    // be restorable, and must not be distinguishable from one that never existed.
    if (!backup || backup.shop !== session.shop) {
      return Response.json({ ok: false, error: "Backup not found" }, { status: 404 });
    }

    // Phase 3.7: restore overwrites live product data, so record who asked.
    const actor = actorFromSession(request, session);
    console.log(`[api/backup] restore of ${backupId} requested by ${describeActor(actor)} for ${session.shop}`);

    // Writes back over every product in the snapshot — one at a time.
    return withPolicy({ policyName: "restore", shop: session.shop }, async () => {
      const result = await restoreBackup({
        prisma, shopifyGraphql, backup,
        token: session.accessToken, version,
        // restoreBackup writes per-record log entries when given a buffer;
        // attribute them to whoever triggered the restore.
        logBuffer: backup.jobId
          ? createLogBuffer({ prisma, jobId: backup.jobId, shop: session.shop, actor })
          : null,
      });

      return Response.json({
        ok: result.ok,
        error: result.error || null,
        restored: result.restored,
        failed: result.failed,
        skipped: result.skipped,
        partial: !!result.partial,
        errors: (result.errors || []).slice(0, 50),
      }, { status: result.ok || result.restored > 0 ? 200 : 400 });
    });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
};
