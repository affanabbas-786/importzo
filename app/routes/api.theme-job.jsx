// POST /api/theme-job
// Creates a ThemeJob and starts the background theme-transfer worker.
// Returns { ok, jobId } immediately — the caller polls /api/theme-status/:jobId.
//
// Modelled on api.migration-job.jsx, including the two guards that file
// needed: a duplicate-submit guard that returns the in-flight job rather
// than erroring, and a real concurrency cap enforced against the DB (an
// in-process slot would cap nothing, because the worker outlives this
// request).

import { authenticate, apiVersion } from "../shopify.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import prisma from "../db.server";
import { runThemeWorker } from "../lib/theme-worker.server";
import { destinationThemeName } from "../lib/theme-zip.server";
import { getSavedSourceStore } from "../lib/safe-db";
import { enforcePolicy, POLICIES } from "../lib/rate-limit.server";
import { actorFromSession, describeActor } from "../lib/audit.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);

  const gate = enforcePolicy({ policyName: "themeJob", shop: session.shop });
  if (!gate.ok) return gate.response;
  gate.release();

  const formData = await request.formData();

  const targetShop = session.shop;
  const targetToken = session.accessToken;
  const version = apiVersion || "2025-10";

  // Digits-only: this value is interpolated into REST paths, so anything
  // else is a path-traversal vector. Same check the synchronous path had.
  const sourceThemeId = String(formData.get("themeId") || "").trim();
  if (!/^\d+$/.test(sourceThemeId)) {
    return Response.json({ ok: false, error: "Invalid theme ID" }, { status: 400 });
  }
  const sourceThemeName = String(formData.get("themeName") || "Transferred Theme").slice(0, 200);

  // Source credentials: session → form → saved SourceStore, the same
  // cascade getSourceCreds uses in the transfer route.
  let sourceShop = "";
  let sourceToken = "";

  const sessionId = String(formData.get("sessionId") || "").trim();
  if (sessionId) {
    try {
      const ts = await prisma.transferSession.findUnique({ where: { id: sessionId } });
      if (ts && ts.status !== "done") {
        sourceShop = ts.sourceShop;
        sourceToken = decrypt(ts.sourceToken);
      }
    } catch (err) {
      console.warn("[api/theme-job] session lookup failed:", err?.message);
    }
  }

  if (!sourceShop || !sourceToken) {
    sourceShop = String(formData.get("sourceUrl") || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    sourceToken = String(formData.get("sourceToken") || "").trim();
  }

  if (!sourceShop || !sourceToken) {
    const saved = await getSavedSourceStore(targetShop);
    if (saved) { sourceShop = saved.sourceUrl; sourceToken = saved.token; }
  }

  if (!sourceShop || !sourceToken) {
    return Response.json({ ok: false, error: "Missing source store credentials" }, { status: 400 });
  }
  if (!sourceShop.includes(".")) sourceShop = sourceShop + ".myshopify.com";

  // Duplicate guard, scoped to the THEME rather than the source shop:
  // transferring two different themes from one source is legitimate, a
  // second job for the same theme never is. Returning the in-flight id
  // (rather than an error) lets a double-click just start polling the job
  // the merchant already has, which is what they wanted anyway.
  const duplicate = await prisma.themeJob.findFirst({
    where: { shop: targetShop, sourceThemeId, status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (duplicate) {
    console.log(`[api/theme-job] duplicate submit for ${targetShop} theme=${sourceThemeId}; returning in-flight job=${duplicate.id}`);
    return Response.json({
      ok: true,
      jobId: duplicate.id,
      alreadyRunning: true,
      message: "This theme is already being transferred — showing that transfer instead of starting a second.",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Stricter than migrationJob's 2: a theme job holds a staging directory
  // and saturates the shop's REST bucket, so two at once on one shop is
  // never useful.
  const inFlight = await prisma.themeJob.count({
    where: { shop: targetShop, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (inFlight >= POLICIES.themeJob.maxConcurrent) {
    return Response.json({
      ok: false,
      error: `This store already has a theme transfer in progress. Wait for it to finish before starting another.`,
      inFlight,
      maxConcurrent: POLICIES.themeJob.maxConcurrent,
    }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }

  const actor = actorFromSession(request, session);

  // Snapshotted, not recomputed later: a resumed job must match on exactly
  // the name the original run used, even if the truncation rules change.
  // The by-name check is what stops a resume creating a second theme.
  const targetThemeName = destinationThemeName(sourceThemeName);

  const job = await prisma.themeJob.create({
    data: {
      shop: targetShop,
      sourceShop,
      sourceThemeId,
      sourceThemeName,
      targetThemeName,
      sourceToken: encrypt(sourceToken),
      destToken: encrypt(targetToken),
      apiVersion: version,
      status: "PENDING",
      phase: "LISTING",
      ...actor,
    },
  });

  console.log(`[api/theme-job] job=${job.id} theme="${targetThemeName}" triggered by ${describeActor(actor)} for ${targetShop}`);

  // Fire-and-forget: the worker lives in the event loop, decoupled from
  // this HTTP response. That decoupling is the entire point of the change.
  runThemeWorker(job.id).catch((err) =>
    console.error(`[api/theme-job] worker crash for job=${job.id}:`, err),
  );

  return Response.json({ ok: true, jobId: job.id }, { headers: { "Cache-Control": "no-store" } });
};
