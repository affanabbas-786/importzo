// SCENARIO 2 — SIGKILL the worker mid-FETCHING, then resume it.
//
// This is the PM2-restart case job-recovery.server.js exists for. The child is
// really killed with SIGKILL (no unwinding, no finally, no terminal status
// write), leaving the row exactly as a crashed worker would: status=RUNNING,
// phase=FETCHING, and a half-full staging directory on disk.
import { fork } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import fsSync from "node:fs";
import { startSourceStore, startDestStore } from "./fake-shopify.mjs";
import { HERE, TMP_DIR, childEnv } from "./lib.mjs";
import { createThemeJob, readJob, resetJobs, prisma } from "./seed.mjs";

const TOTAL = 40;
const THEME = { "layout/theme.liquid": "<html>{{ content_for_layout }}</html>" };
for (let i = 0; i < TOTAL - 1; i++) THEME[`sections/s${i}.liquid`] = `<section>${i}</section>`;

const KILL_AFTER = 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};

const stagedKeys = () => {
  const root = path.join(TMP_DIR, "importzo-theme-stage", "sc2");
  const out = [];
  const walk = (dir, prefix) => {
    if (!fsSync.existsSync(dir)) return;
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
};

const spawnChild = (jobId) => fork(path.join(HERE, "run-worker.mjs"), [jobId], {
  env: childEnv(), stdio: ["ignore", "pipe", "pipe", "ipc"],
});

await resetJobs();
fsSync.rmSync(path.join(TMP_DIR, "importzo-theme-stage", "sc2"), { recursive: true, force: true });

// 30ms per asset: slow enough that a kill lands reliably inside FETCHING,
// fast enough that the scenario finishes in seconds.
const source = await startSourceStore({ assets: THEME, onAssetRequest: () => sleep(30) });
const dest = await startDestStore({ processingPolls: 0 });

await createThemeJob({
  id: "sc2", shop: dest.shop, sourceShop: source.shop,
  sourceThemeId: source.themeId, targetThemeName: "Dawn (from source)",
});

// ── Run 1: kill it mid-FETCHING ────────────────────────────────────────────
const child = spawnChild("sc2");
const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
while (source.state.assetRequests.length < KILL_AFTER) await sleep(10);
child.kill("SIGKILL");
const firstExit = await exited;
await sleep(150); // let in-flight disk writes settle

const afterKill = await readJob("sc2");
const stagedAtKill = stagedKeys();
const requestsRun1 = source.state.assetRequests.length;

check("child died by SIGKILL, not a clean exit", () => {
  assert.equal(firstExit.signal, "SIGKILL");
  assert.notEqual(firstExit.code, 0);
});
check("row left mid-flight: status=RUNNING", () => assert.equal(afterKill.status, "RUNNING"));
check("row left mid-flight: phase=FETCHING", () => assert.equal(afterKill.phase, "FETCHING"));
check("manifest size was persisted before the crash", () => assert.equal(afterKill.assetsTotal, TOTAL));
check("some but not all assets staged on disk", () => {
  assert.ok(stagedAtKill.length > 0, "nothing staged");
  assert.ok(stagedAtKill.length < TOTAL, `everything staged (${stagedAtKill.length})`);
});
check("job-recovery would see this row as an orphan", () => {
  // Exactly the predicate recoverStale uses: in-flight status, and no worker
  // alive in any process to claim it.
  assert.ok(["RUNNING", "PENDING"].includes(afterKill.status));
});

// ── Run 2: resume ──────────────────────────────────────────────────────────
const resumeStartIndex = source.state.assetRequests.length;
const second = spawnChild("sc2");
const secondExit = await new Promise((r) => second.on("exit", (code) => r(code)));
const job = await readJob("sc2");
const requestsRun2 = source.state.assetRequests.slice(resumeStartIndex);

check("resumed child exits cleanly", () => assert.equal(secondExit, 0));
check("job COMPLETED after resume", () => assert.equal(job.status, "COMPLETED"));
check("all assets accounted for", () => assert.equal(job.assetsFetched, TOTAL));
check("no asset failures across the interruption", () => assert.equal(job.assetsFailed, 0));

check("resume did NOT re-download anything already staged", () => {
  const redownloaded = requestsRun2.filter((k) => stagedAtKill.includes(k));
  assert.deepEqual(redownloaded, [], `re-fetched ${redownloaded.length}: ${redownloaded.slice(0, 5)}`);
});
check("resume fetched exactly the remainder", () => {
  const expected = Object.keys(THEME).filter((k) => !stagedAtKill.includes(k)).sort();
  assert.deepEqual([...new Set(requestsRun2)].sort(), expected);
});
check("total work across both runs < doing it twice", () =>
  assert.ok(requestsRun1 + requestsRun2.length < TOTAL * 2,
    `${requestsRun1} + ${requestsRun2.length} vs ${TOTAL * 2}`));

check("exactly one theme created despite the interruption", () =>
  assert.equal(dest.state.creates.length, 1));
check("staging cleaned up after the resumed run completed", () =>
  assert.deepEqual(stagedKeys(), []));

await source.close(); await dest.close(); await prisma.$disconnect();

console.log(`\n=== SCENARIO 2: SIGKILL mid-FETCHING + resume ===`);
console.log(`    run1 fetched ${requestsRun1} assets, staged ${stagedAtKill.length}; run2 fetched ${requestsRun2.length}; total ${TOTAL}\n`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "\n      " + r.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
