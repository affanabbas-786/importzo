// ═══════════════════════════════════════════════════════════════════
// Background worker for theme transfer.
//
// Mirrors migration-worker.server.js in shape — module-level activeWorkers
// map, fire-and-forget entry point, terminal status written in `finally` —
// but the work itself has a fundamentally different structure.
//
// Product migration is a UNIFORM LOOP: N interchangeable items, one cursor,
// resume by skipping what's already done. Theme transfer is a
// HETEROGENEOUS PIPELINE whose expensive middle produces a single artifact:
//
//   LISTING     1 call, <1s        re-run on resume
//   FETCHING    N calls, ~95% of wall time    resumable (disk staging)
//   PACKAGING   CPU, seconds       re-run on resume
//   MEDIA       variable           re-run (dedupes by filename)
//   CREATING    1 call             NOT IDEMPOTENT — see phaseCreating
//   EXTRACTING  poll, up to 180s   resumable (polls recorded newThemeId)
//
// So what gets checkpointed is WHICH STEP we reached, not just how far
// through a list — hence ThemeJob.phase, and the deliberate switch
// fall-through in runThemeWorker.
// ═══════════════════════════════════════════════════════════════════

import prisma from "../db.server.js";
import { decrypt } from "../utils/encryption.server.js";
import { shopifyFetch, shopifyGraphql as rawShopifyGraphql } from "./shopify-api.server.js";
import { createTokenProvider } from "./job-tokens.server.js";
import { recordUsageAndCheck } from "./usage.server.js";
import {
  saveThemeZip, deleteThemeZipNow,
  isAssetStaged, stageAsset, readStagedAssets, clearStagedAssets,
} from "./theme-zip.server.js";
import { extractThemeFileReferences, createFilesOnTargetFromThemeRefs } from "./theme-media.server.js";

export const PHASE = Object.freeze({
  LISTING: "LISTING",
  FETCHING: "FETCHING",
  PACKAGING: "PACKAGING",
  MEDIA: "MEDIA",
  CREATING: "CREATING",
  EXTRACTING: "EXTRACTING",
});

// Ordered, so a resume can tell "already past this" from "not yet reached".
export const PHASE_ORDER = [
  PHASE.LISTING, PHASE.FETCHING, PHASE.PACKAGING,
  PHASE.MEDIA, PHASE.CREATING, PHASE.EXTRACTING,
];

// Assets fetched in parallel. Rate limiting itself lives in shopifyFetch
// (per-shop concurrency cap + pacing off X-Shopify-Shop-Api-Call-Limit), so
// this is only a bound on how many asset buffers exist at once before they
// are written to disk.
const FETCH_BATCH = 4;

// How often assetsFetched is flushed to the DB. At the ~2 assets/sec a
// Basic-tier REST bucket allows, this is a write roughly every 12s — which
// also keeps updatedAt fresh enough for job-recovery's staleness check.
const CHECKPOINT_EVERY = 25;

const EXTRACT_TIMEOUT_MS = 180_000;
const EXTRACT_POLL_MS = 5_000;
const ERROR_LOG_CAP = 200;

const activeWorkers = new Map();
export function isWorkerActive(jobId) { return activeWorkers.has(jobId); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function patch(jobId, data) {
  return prisma.themeJob.update({ where: { id: jobId }, data });
}

function parseErrorLog(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phases
// ─────────────────────────────────────────────────────────────────────

/**
 * LISTING — fetch the source manifest, verify the source token, and decide
 * whether this theme already exists on the destination.
 *
 * Returns { assetKeys, adopted } where `adopted` is a destination theme id
 * to jump straight to EXTRACTING for. That adoption path is what makes a
 * resume safe: see phaseCreating.
 */
async function phaseListing(job, ctx) {
  const { sourceShop, sourceThemeId, apiVersion } = job;
  const sourceToken = await ctx.sourceTokens.get();

  const res = await shopifyFetch(
    `https://${sourceShop}/admin/api/${apiVersion}/themes/${sourceThemeId}/assets.json`,
    { headers: { "X-Shopify-Access-Token": sourceToken } },
  );
  if (!res.ok) {
    // A 401 here is the single most common real failure and the least
    // self-explanatory, so it is named rather than surfaced as an HTTP code.
    if (res.status === 401 || res.status === 403) {
      throw new Error("Source store session expired or the app was uninstalled from the source store. Reconnect the source store and try again.");
    }
    throw new Error(`Failed to fetch theme assets: HTTP ${res.status}`);
  }
  const assetKeys = ((await res.json()).assets || []).map((a) => a.key).filter(Boolean);

  const adopted = await findExistingTheme(job, ctx);

  await patch(job.id, { assetsTotal: assetKeys.length, phase: adopted ? PHASE.EXTRACTING : PHASE.FETCHING });
  return { assetKeys, adopted };
}

/**
 * Looks for a destination theme already named targetThemeName.
 *
 * Serves two purposes with one call. On a first run it is the idempotency
 * check that stops a re-submitted transfer duplicating a theme. On a resume
 * entering CREATING it is what prevents creating a SECOND theme when the
 * previous attempt died after Shopify created one but before newThemeId was
 * persisted — which is why targetThemeName is snapshotted on the job rather
 * than recomputed.
 */
async function findExistingTheme(job, ctx) {
  const targetToken = await ctx.destTokens.get();
  try {
    const res = await shopifyFetch(
      `https://${job.shop}/admin/api/${job.apiVersion}/themes.json`,
      { headers: { "X-Shopify-Access-Token": targetToken } },
    );
    if (!res.ok) return null;
    const themes = (await res.json()).themes || [];
    const match = themes.find((t) => t.name === job.targetThemeName);
    return match?.id ? String(match.id) : null;
  } catch (err) {
    // Never fatal: failing to CHECK must not fail the transfer. Worst case
    // is the duplicate this check exists to avoid, which is recoverable;
    // failing outright is not.
    console.warn(`[theme-worker] job=${job.id} existing-theme check failed:`, err?.message);
    return null;
  }
}

/**
 * FETCHING — download every asset the manifest lists, staging each to disk.
 *
 * Assets already on disk from a previous run are skipped, which is the whole
 * resumability story for the phase that dominates wall time.
 */
async function phaseFetching(job, ctx, assetKeys) {
  const errorLog = parseErrorLog(job.errorLog);
  let fetched = 0;
  let failed = 0;
  let sinceCheckpoint = 0;

  const fetchOne = async (key) => {
    if (await isAssetStaged(job.id, key)) { fetched++; return; }
    const sourceToken = await ctx.sourceTokens.get();
    try {
      const res = await shopifyFetch(
        `https://${job.sourceShop}/admin/api/${job.apiVersion}/themes/${job.sourceThemeId}/assets.json?asset[key]=${encodeURIComponent(key)}`,
        { headers: { "X-Shopify-Access-Token": sourceToken } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const asset = (await res.json()).asset;
      if (!asset) throw new Error("empty response");

      let data;
      if (asset.value !== undefined && asset.value !== null) {
        data = Buffer.from(asset.value, "utf8");
      } else if (asset.attachment) {
        data = Buffer.from(asset.attachment, "base64");
      } else if (asset.public_url) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30_000);
        try {
          const cdn = await fetch(asset.public_url, { signal: ctrl.signal });
          if (!cdn.ok) throw new Error(`CDN HTTP ${cdn.status}`);
          data = Buffer.from(await cdn.arrayBuffer());
        } finally {
          clearTimeout(t);
        }
      } else {
        throw new Error("no readable content returned by Shopify");
      }

      await stageAsset(job.id, key, data);
      fetched++;
    } catch (err) {
      // One unreadable asset degrades the theme; it does not fail the job.
      // The layout/theme.liquid assertion in PACKAGING is what actually
      // guards against shipping something unusable.
      failed++;
      errorLog.push({ key, error: err?.message || String(err) });
    }
  };

  for (let i = 0; i < assetKeys.length; i += FETCH_BATCH) {
    await Promise.all(assetKeys.slice(i, i + FETCH_BATCH).map(fetchOne));
    sinceCheckpoint += FETCH_BATCH;
    if (sinceCheckpoint >= CHECKPOINT_EVERY || i + FETCH_BATCH >= assetKeys.length) {
      await patch(job.id, {
        assetsFetched: fetched,
        assetsFailed: failed,
        errorLog: JSON.stringify(errorLog.slice(-ERROR_LOG_CAP)),
      });
      sinceCheckpoint = 0;
    }
  }

  await patch(job.id, {
    assetsFetched: fetched,
    assetsFailed: failed,
    errorLog: JSON.stringify(errorLog.slice(-ERROR_LOG_CAP)),
    phase: PHASE.PACKAGING,
  });
  return { fetched, failed };
}

/**
 * PACKAGING — read staged assets back and build the ZIP.
 *
 * Driven by the manifest, not by walking the staging directory, so the ZIP
 * contains exactly what the source theme has.
 */
async function phasePackaging(job, assetKeys) {
  const files = await readStagedAssets(job.id, assetKeys);

  if (!files.some((f) => f.name === "layout/theme.liquid")) {
    throw new Error("Source theme does not contain layout/theme.liquid, so Shopify cannot create a valid destination theme.");
  }

  const { id: zipId, token: zipToken } = await saveThemeZip(files);
  await patch(job.id, { zipId, zipToken, phase: PHASE.MEDIA });
  return { files, zipId, zipToken };
}

/**
 * MEDIA — upload store files the theme's settings reference.
 *
 * Re-runs wholesale on resume rather than being checkpointed per file. Safe
 * because Shopify dedupes by filename; the cost is re-spent API calls on a
 * phase that is usually small. Revisit if a real theme shows this taking
 * meaningful time.
 */
async function phaseMedia(job, ctx, files) {
  const refs = extractThemeFileReferences(files);
  if (refs.length) {
    const targetToken = await ctx.destTokens.get();
    const result = await createFilesOnTargetFromThemeRefs({
      shopifyGraphql: ctx.graphql,
      sourceShop: job.sourceShop,
      targetShop: job.shop,
      targetToken,
      refs,
    });
    if (result.uploaded < result.total) {
      const errorLog = parseErrorLog((await prisma.themeJob.findUnique({ where: { id: job.id }, select: { errorLog: true } }))?.errorLog);
      errorLog.push({ key: "content/files", error: `Theme media copied ${result.uploaded}/${result.total}: ${result.warnings.slice(0, 5).join("; ")}` });
      await patch(job.id, { errorLog: JSON.stringify(errorLog.slice(-ERROR_LOG_CAP)) });
    }
  }
  await patch(job.id, { phase: PHASE.CREATING });
}

/**
 * CREATING — the one irreversible step.
 *
 * Shopify creates a real theme here, and there is an unavoidable window
 * between the API returning and newThemeId being persisted. A crash inside
 * it orphans a theme the job doesn't know about, and a naive resume would
 * create a second one. Two mitigations, both required:
 *
 *   1. newThemeId and the phase advance are written in ONE update,
 *      immediately on the create response, before the first poll — which
 *      shrinks the window to a single DB write.
 *   2. Because that window cannot be closed entirely, every entry into this
 *      phase re-runs the by-name check first and ADOPTS a matching theme
 *      instead of creating another.
 */
async function phaseCreating(job, ctx) {
  const adopted = await findExistingTheme(job, ctx);
  if (adopted) {
    console.log(`[theme-worker] job=${job.id} adopting existing destination theme ${adopted} — not creating a second`);
    await patch(job.id, { newThemeId: adopted, phase: PHASE.EXTRACTING });
    return adopted;
  }

  const fresh = await prisma.themeJob.findUnique({
    where: { id: job.id },
    select: { zipId: true, zipToken: true },
  });
  if (!fresh?.zipId || !fresh?.zipToken) {
    throw new Error("Theme package is missing — the staged ZIP was not recorded on the job.");
  }

  const appBaseUrl = String(process.env.SHOPIFY_APP_URL || "https://importzo.dazzletech.co").replace(/\/+$/, "");
  const zipSrcUrl = `${appBaseUrl}/theme-zip/${fresh.zipId}?token=${fresh.zipToken}`;
  const targetToken = await ctx.destTokens.get();

  console.log(`[theme-worker] job=${job.id} creating destination theme on ${job.shop} from ${zipSrcUrl}`);

  const res = await shopifyFetch(`https://${job.shop}/admin/api/${job.apiVersion}/themes.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": targetToken },
    body: JSON.stringify({ theme: { name: job.targetThemeName, src: zipSrcUrl, role: "unpublished" } }),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { /* raw body used as fallback */ }
    throw new Error(`Failed to create theme from ZIP (HTTP ${res.status}): ${parsed.errors ? JSON.stringify(parsed.errors) : raw.slice(0, 300) || "no response body"}`);
  }

  const created = (await res.json()).theme;
  if (!created?.id) throw new Error("Theme creation failed: Shopify did not return a theme ID");

  // The narrowest possible window: one write, immediately, before any poll.
  await patch(job.id, { newThemeId: String(created.id), phase: PHASE.EXTRACTING });
  return String(created.id);
}

/** EXTRACTING — poll until Shopify finishes unpacking the ZIP. */
async function phaseExtracting(job, ctx, themeId) {
  const id = themeId || job.newThemeId;
  if (!id) throw new Error("No destination theme id recorded — cannot confirm extraction.");

  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(EXTRACT_POLL_MS);
    const targetToken = await ctx.destTokens.get();
    const res = await shopifyFetch(`https://${job.shop}/admin/api/${job.apiVersion}/themes/${id}.json`, {
      headers: { "X-Shopify-Access-Token": targetToken },
    });
    if (res.status === 404) {
      throw new Error(`Theme (ID ${id}) disappeared after creation — the destination store may have reached its theme limit or rejected the ZIP.`);
    }
    if (!res.ok) continue; // transient; keep polling until the deadline
    const theme = (await res.json()).theme;
    if (theme?.processing === false) return theme;
  }
  throw new Error(`Theme (ID ${id}) is still processing after ${EXTRACT_TIMEOUT_MS / 1000} seconds. Check the destination store's themes page; if it is incomplete, retry with a smaller theme.`);
}

// ─────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────

export async function runThemeWorker(jobId, { createTokens = createTokenProvider } = {}) {
  // Registered synchronously, before the first await, so isWorkerActive is
  // already true by the time any status poll for this job can arrive.
  if (activeWorkers.has(jobId)) return;
  activeWorkers.set(jobId, { startedAt: Date.now() });

  try {
    const job = await prisma.themeJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    if (job.status === "COMPLETED" || job.status === "FAILED") return;

    await patch(jobId, { status: "RUNNING" });

    // Tokens on the job are a snapshot taken at creation, and offline access
    // tokens live 60 minutes — a resumed theme job can easily outlive that.
    // Both are fallbacks behind a provider that re-resolves from the session
    // store as the job runs. See job-tokens.server.js.
    const ctx = {
      sourceTokens: createTokens({ shop: job.sourceShop, fallbackToken: decrypt(job.sourceToken) }),
      destTokens: createTokens({ shop: job.shop, fallbackToken: decrypt(job.destToken) }),
      graphql: (shop, token, query, variables) => rawShopifyGraphql(shop, token, query, variables, job.apiVersion),
    };

    // Re-derived on every entry rather than persisted: it is one cheap call,
    // and PACKAGING needs the manifest to know what to read back off disk.
    let assetKeys = [];
    let adopted = null;
    let files = null;
    let themeId = job.newThemeId || null;

    const startAt = PHASE_ORDER.indexOf(job.phase);
    const from = startAt === -1 ? 0 : startAt;

    // A resume past LISTING still needs the manifest, so it is fetched
    // regardless — just without re-running the adoption check, which
    // phaseCreating does for itself.
    if (from > PHASE_ORDER.indexOf(PHASE.LISTING)) {
      const sourceToken = await ctx.sourceTokens.get();
      const res = await shopifyFetch(
        `https://${job.sourceShop}/admin/api/${job.apiVersion}/themes/${job.sourceThemeId}/assets.json`,
        { headers: { "X-Shopify-Access-Token": sourceToken } },
      );
      if (!res.ok) throw new Error(`Failed to re-read theme assets on resume: HTTP ${res.status}`);
      assetKeys = ((await res.json()).assets || []).map((a) => a.key).filter(Boolean);
    }

    // Deliberate fall-through: resume enters at the recorded phase and runs
    // forward from there. `break` would be the bug here, not its absence.
    /* eslint-disable no-fallthrough */
    switch (from) {
      case 0: { // LISTING
        const listed = await phaseListing(job, ctx);
        assetKeys = listed.assetKeys;
        adopted = listed.adopted;
        if (adopted) {
          // Already on the destination — skip straight to confirming it.
          themeId = adopted;
          await patch(jobId, { newThemeId: adopted });
          const theme = await phaseExtracting({ ...job, newThemeId: adopted }, ctx, adopted);
          await complete(jobId, job, theme, { skipped: true });
          return;
        }
      }
      case 1: // FETCHING
        await phaseFetching(job, ctx, assetKeys);
      case 2: // PACKAGING
        ({ files } = await phasePackaging(job, assetKeys));
      case 3: // MEDIA
        if (!files) files = await readStagedAssets(job.id, assetKeys);
        await phaseMedia(job, ctx, files);
      case 4: // CREATING
        themeId = await phaseCreating(job, ctx);
      case 5: { // EXTRACTING
        const theme = await phaseExtracting(job, ctx, themeId);
        await complete(jobId, job, theme, { skipped: false });
      }
    }
    /* eslint-enable no-fallthrough */
  } catch (err) {
    console.error(`[theme-worker] job=${jobId} FAILED:`, err?.message);
    try {
      const current = await prisma.themeJob.findUnique({ where: { id: jobId }, select: { errorLog: true } });
      const log = parseErrorLog(current?.errorLog);
      log.push({ key: "(job)", error: err?.message || String(err) });
      await patch(jobId, { status: "FAILED", errorLog: JSON.stringify(log.slice(-ERROR_LOG_CAP)) });
    } catch { /* best-effort */ }
  } finally {
    activeWorkers.delete(jobId);
  }
}

/**
 * Terminal success. Records usage, cleans up temp files, marks COMPLETED.
 *
 * Usage is recorded HERE and nowhere earlier: a whole theme is one record,
 * and a job that fails before the theme exists must not consume one. The
 * synchronous path had that property and it is preserved rather than
 * re-derived.
 *
 * `skipped` means an existing destination theme was adopted rather than
 * created — nothing new was produced, so no record is consumed.
 */
async function complete(jobId, job, theme, { skipped }) {
  if (!skipped) {
    try {
      await recordUsageAndCheck({ prisma, shop: job.shop, count: 1 });
    } catch (err) {
      console.warn(`[theme-worker] job=${jobId} usage recording failed:`, err?.message);
    }
  }

  const fresh = await prisma.themeJob.findUnique({
    where: { id: jobId },
    select: { zipId: true, zipToken: true },
  });
  await deleteThemeZipNow(fresh?.zipId, fresh?.zipToken).catch(() => {});
  await clearStagedAssets(jobId);

  await patch(jobId, {
    status: "COMPLETED",
    phase: PHASE.EXTRACTING,
    newThemeId: theme?.id ? String(theme.id) : undefined,
  });
  console.log(`[theme-worker] job=${jobId} COMPLETED theme=${theme?.id}${skipped ? " (adopted existing)" : ""}`);
}
