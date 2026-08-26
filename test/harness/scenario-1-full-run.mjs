// SCENARIO 1 — the whole phase machine, LISTING → EXTRACTING, in one run.
import { fork } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { startSourceStore, startDestStore } from "./fake-shopify.mjs";
import fsSync from "node:fs";
import { HERE, TMP_DIR, childEnv } from "./lib.mjs";
import { createThemeJob, readJob, resetJobs, prisma } from "./seed.mjs";

const THEME = {
  "layout/theme.liquid": "<html>{{ content_for_layout }}</html>",
  "templates/index.json": '{"sections":{}}',
  "sections/header.liquid": "<header>hi</header>",
  "sections/footer.liquid": "<footer>bye</footer>",
  "assets/base.css": "body{margin:0}",
  "config/settings_data.json": '{"current":{}}',
  "snippets/icon.liquid": "<svg></svg>",
};

const runChild = (jobId) => new Promise((resolve) => {
  const child = fork(path.join(HERE, "run-worker.mjs"), [jobId], {
    env: childEnv(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  child.on("exit", (code) => resolve({ code, output: out.join("") }));
});

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};

await resetJobs();
const source = await startSourceStore({ assets: THEME });
// processingPolls: 1 → the first poll still reports processing, so EXTRACTING
// is proven to be a loop rather than a single lucky call.
const dest = await startDestStore({ processingPolls: 1 });

await createThemeJob({
  id: "sc1", shop: dest.shop, sourceShop: source.shop,
  sourceThemeId: source.themeId, targetThemeName: "Dawn (from source)",
});

const started = Date.now();
const { code, output } = await runChild("sc1");
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const job = await readJob("sc1");

check("child exits cleanly", () => assert.equal(code, 0));
check("job COMPLETED", () => assert.equal(job.status, "COMPLETED"));
check("manifest size recorded", () => assert.equal(job.assetsTotal, Object.keys(THEME).length));
check("every asset fetched", () => assert.equal(job.assetsFetched, Object.keys(THEME).length));
check("no asset failures", () => assert.equal(job.assetsFailed, 0));
check("errorLog empty", () => assert.deepEqual(JSON.parse(job.errorLog), []));
check("each asset requested exactly once", () => {
  const counts = {};
  for (const k of source.state.assetRequests) counts[k] = (counts[k] || 0) + 1;
  assert.deepEqual(Object.keys(counts).sort(), Object.keys(THEME).sort());
  assert.ok(Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
});
check("exactly one theme created on the destination", () => assert.equal(dest.state.creates.length, 1));
check("created unpublished, under the snapshotted name", () => {
  assert.equal(dest.state.creates[0].name, "Dawn (from source)");
  assert.equal(dest.state.creates[0].role, "unpublished");
});
check("ZIP served from a tokenised app URL", () =>
  assert.match(dest.state.creates[0].src, /^https:\/\/harness\.invalid\/theme-zip\/[\w-]+\?token=\w+$/));
check("newThemeId persisted", () => assert.equal(job.newThemeId, String(dest.state.creates[0].id)));
check("EXTRACTING really polled until processing cleared", () =>
  assert.ok(dest.state.polls[String(dest.state.creates[0].id)] >= 2,
    `polls=${JSON.stringify(dest.state.polls)}`));
// complete() deletes the ZIP file and the staging directory but deliberately
// leaves zipId/zipToken on the row, so assert the thing that actually matters
// — that nothing is left on disk — rather than the column value.
check("ZIP file removed from disk on success", () => {
  assert.ok(job.zipId, "expected a zipId to have been recorded");
  const zip = path.join(TMP_DIR, "importzo-theme-zips", `${job.zipId}-${job.zipToken}.zip`);
  assert.equal(fsSync.existsSync(zip), false, `still present: ${zip}`);
});
check("staging directory removed from disk on success", () => {
  const stage = path.join(TMP_DIR, "importzo-theme-stage", "sc1");
  assert.equal(fsSync.existsSync(stage), false, `still present: ${stage}`);
});

await source.close(); await dest.close(); await prisma.$disconnect();

console.log(`\n=== SCENARIO 1: full run (${elapsed}s) ===`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "\n      " + r.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) { console.log("\n--- worker output ---\n" + output); process.exitCode = 1; }
