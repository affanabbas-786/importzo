// SCENARIO 3 — the adoption guard.
//
// Two paths reach it, and both must end with ONE theme on the destination:
//
//   3a  Crash inside CREATING, after Shopify made the theme but before
//       newThemeId was written. The resume re-enters CREATING and must adopt
//       the orphan rather than making a second one. This is the window
//       phaseCreating's by-name check exists for, reproduced exactly by
//       hanging the create response until the child is SIGKILLed.
//
//   3b  A transfer re-submitted against a destination that already has a
//       theme of that name. Adoption happens at LISTING, and because nothing
//       new is produced no usage record is consumed.
import { fork } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import fsSync from "node:fs";
import { startSourceStore, startDestStore } from "./fake-shopify.mjs";
import { HERE, TMP_DIR, childEnv } from "./lib.mjs";
import { createThemeJob, readJob, resetJobs, prisma } from "./seed.mjs";

const THEME = {
  "layout/theme.liquid": "<html>{{ content_for_layout }}</html>",
  "templates/index.json": '{"sections":{}}',
  "sections/header.liquid": "<header>hi</header>",
};
const NAME = "Dawn (from source)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};
const spawnChild = (jobId) => fork(path.join(HERE, "run-worker.mjs"), [jobId], {
  env: childEnv(), stdio: ["ignore", "pipe", "pipe", "ipc"],
});
const usageFor = (shop) => prisma.shopPlan.findUnique({ where: { shop } });

await resetJobs();
for (const id of ["sc3a", "sc3b"]) {
  fsSync.rmSync(path.join(TMP_DIR, "importzo-theme-stage", id), { recursive: true, force: true });
}

// ── 3a: crash inside the CREATING window ───────────────────────────────────
let createSeen = null;
const sawCreate = new Promise((r) => { createSeen = r; });
let hangFirstCreate = true;

const sourceA = await startSourceStore({ assets: THEME });
const destA = await startDestStore({
  processingPolls: 0,
  onCreate: async () => {
    if (!hangFirstCreate) return;
    hangFirstCreate = false;
    createSeen();
    await new Promise(() => {}); // never responds — the child is killed here
  },
});

await createThemeJob({ id: "sc3a", shop: destA.shop, sourceShop: sourceA.shop, sourceThemeId: sourceA.themeId, targetThemeName: NAME });

const childA = spawnChild("sc3a");
const exitA = new Promise((r) => childA.on("exit", (code, signal) => r({ code, signal })));
await sawCreate;
await sleep(80);
childA.kill("SIGKILL");
const firstExit = await exitA;
await sleep(150);

const midCrash = await readJob("sc3a");
const themesAfterCrash = destA.state.themes.length;

check("3a: killed while Shopify was creating the theme", () => assert.equal(firstExit.signal, "SIGKILL"));
check("3a: the destination DOES have an orphan theme", () => assert.equal(themesAfterCrash, 1));
check("3a: but the job never learned its id", () => assert.equal(midCrash.newThemeId, null));
check("3a: row parked at phase=CREATING", () => assert.equal(midCrash.phase, "CREATING"));
check("3a: row still RUNNING for job-recovery to find", () => assert.equal(midCrash.status, "RUNNING"));

const resumeA = spawnChild("sc3a");
const outA = [];
resumeA.stdout.on("data", (d) => outA.push(String(d)));
const resumeExitA = await new Promise((r) => resumeA.on("exit", (code) => r(code)));
const doneA = await readJob("sc3a");

check("3a: resumed child exits cleanly", () => assert.equal(resumeExitA, 0));
check("3a: job COMPLETED", () => assert.equal(doneA.status, "COMPLETED"));
check("3a: NO second theme was created", () => assert.equal(destA.state.creates.length, 1));
check("3a: destination still holds exactly one theme", () => assert.equal(destA.state.themes.length, 1));
check("3a: the orphan was adopted, by id", () =>
  assert.equal(doneA.newThemeId, String(destA.state.themes[0].id)));
check("3a: adoption was logged as such", () =>
  assert.match(outA.join(""), /adopting existing destination theme .* not creating a second/));
const planA = await usageFor(destA.shop);
check("3a: exactly one record consumed across the crash+resume", () =>
  assert.equal(planA?.recordsUsed, 1, `recordsUsed=${planA?.recordsUsed}`));

await sourceA.close(); await destA.close();

// ── 3b: re-submitted against a destination that already has the theme ──────
const sourceB = await startSourceStore({ assets: THEME });
const destB = await startDestStore({
  processingPolls: 0,
  themes: [{ id: 777, name: NAME, role: "unpublished", processing: false }],
});

await createThemeJob({ id: "sc3b", shop: destB.shop, sourceShop: sourceB.shop, sourceThemeId: sourceB.themeId, targetThemeName: NAME });

const childB = spawnChild("sc3b");
const exitB = await new Promise((r) => childB.on("exit", (code) => r(code)));
const doneB = await readJob("sc3b");
const planB = await usageFor(destB.shop);

check("3b: exits cleanly", () => assert.equal(exitB, 0));
check("3b: job COMPLETED", () => assert.equal(doneB.status, "COMPLETED"));
check("3b: nothing was created — the existing theme was adopted", () =>
  assert.equal(destB.state.creates.length, 0));
check("3b: adopted the pre-existing theme id", () => assert.equal(doneB.newThemeId, "777"));
check("3b: adopting at LISTING skips the download entirely", () =>
  assert.equal(sourceB.state.assetRequests.length, 0));
check("3b: no usage record consumed when nothing new was produced", () =>
  assert.equal(planB?.recordsUsed ?? 0, 0, `recordsUsed=${planB?.recordsUsed}`));

await sourceB.close(); await destB.close(); await prisma.$disconnect();

console.log(`\n=== SCENARIO 3: adoption guard ===`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "\n      " + r.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
