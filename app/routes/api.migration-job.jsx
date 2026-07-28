// POST /api/migration-job
// Creates a MigrationJob record and starts the background product-transfer worker.
// Returns { ok, jobId } immediately — the caller polls /api/migration-status/:jobId.

import { authenticate, apiVersion } from "../shopify.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import prisma from "../db.server";
import { runMigrationWorker } from "../lib/migration-worker.server";
import { getSavedSourceStore } from "../lib/safe-db";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const targetShop = session.shop;
  const targetToken = session.accessToken;
  const version = apiVersion || "2025-10";
  const conflictMode = (formData.get("conflictMode") || "skip").trim();

  // Resolve source credentials (session-based or saved SourceStore)
  let sourceShop = "";
  let sourceToken = "";

  const sessionId = (formData.get("sessionId") || "").trim();
  if (sessionId) {
    try {
      const ts = await prisma.transferSession.findUnique({ where: { id: sessionId } });
      if (ts && ts.status !== "done") {
        sourceShop = ts.sourceShop;
        sourceToken = decrypt(ts.sourceToken);
      }
    } catch (err) {
      console.warn("[api/migration-job] session lookup failed:", err?.message);
    }
  }

  if (!sourceShop || !sourceToken) {
    sourceShop = (formData.get("sourceShop") || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    sourceToken = (formData.get("sourceToken") || "").trim();
  }

  if (!sourceShop || !sourceToken) {
    const saved = await getSavedSourceStore(targetShop);
    if (saved) { sourceShop = saved.sourceUrl; sourceToken = saved.token; }
  }

  if (!sourceShop || !sourceToken) {
    return Response.json({ ok: false, error: "Missing source store credentials" }, { status: 400 });
  }
  if (!sourceShop.includes(".")) sourceShop = sourceShop + ".myshopify.com";

  const job = await prisma.migrationJob.create({
    data: {
      shop: targetShop,
      sourceShop,
      sourceToken: encrypt(sourceToken),
      destToken: encrypt(targetToken),
      apiVersion: version,
      conflictMode,
      status: "PENDING",
    },
  });

  // Fire-and-forget: worker runs in the Node.js event loop, decoupled from this HTTP response.
  runMigrationWorker(job.id).catch((err) =>
    console.error(`[api/migration-job] worker crash for job=${job.id}:`, err),
  );

  return Response.json({ ok: true, jobId: job.id });
};
