// POST /api/migration-job
// Creates a MigrationJob record and starts the background product-transfer worker.
// Returns { ok, jobId } immediately — the caller polls /api/migration-status/:jobId.

import { authenticate, apiVersion } from "../shopify.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import prisma from "../db.server";
import { runMigrationWorker } from "../lib/migration-worker.server";
import { getSavedSourceStore } from "../lib/safe-db";
import { enforcePolicy, POLICIES } from "../lib/rate-limit.server";
import { actorFromSession, describeActor } from "../lib/audit.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);

  // Rate limit job creation. Note the concurrency cap is enforced against
  // the DB below rather than an in-process slot: the worker is
  // fire-and-forget, so it outlives this request — releasing a slot when the
  // response returns would cap nothing.
  const gate = enforcePolicy({ policyName: "migrationJob", shop: session.shop });
  if (!gate.ok) return gate.response;
  gate.release();

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

  // Real concurrency control for background work: refuse to queue another
  // migration while this shop already has one in flight. Without this, a
  // merchant could start N simultaneous full-catalog migrations and starve
  // every other shop on the box — the exact scenario this item is for.
  const inFlight = await prisma.migrationJob.count({
    where: { shop: targetShop, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (inFlight >= POLICIES.migrationJob.maxConcurrent) {
    return Response.json({
      ok: false,
      error: `This store already has ${inFlight} migration(s) in progress. Wait for them to finish before starting another.`,
      inFlight,
      maxConcurrent: POLICIES.migrationJob.maxConcurrent,
    }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }

  // Phase 3.7: capture WHO triggered this, and from where, at trigger time.
  // The worker is fire-and-forget, so this is the only moment a request (and
  // therefore an IP and a session) still exists to attribute it to.
  const actor = actorFromSession(request, session);

  const job = await prisma.migrationJob.create({
    data: {
      shop: targetShop,
      sourceShop,
      sourceToken: encrypt(sourceToken),
      destToken: encrypt(targetToken),
      apiVersion: version,
      conflictMode,
      status: "PENDING",
      ...actor,
    },
  });

  console.log(`[api/migration-job] job=${job.id} triggered by ${describeActor(actor)} for ${targetShop}`);

  // Fire-and-forget: worker runs in the Node.js event loop, decoupled from this HTTP response.
  runMigrationWorker(job.id).catch((err) =>
    console.error(`[api/migration-job] worker crash for job=${job.id}:`, err),
  );

  return Response.json({ ok: true, jobId: job.id });
};
