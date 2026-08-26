// Child process: runs ONE theme job to completion, then exits.
//
// Separate process on purpose — that is what makes `kill -9` a faithful
// stand-in for the PM2 restart this recovery path exists for. An in-process
// abort would unwind cleanly and prove nothing.
import { APP_DIR } from "./lib.mjs";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: run-worker.mjs <jobId>");

const { runThemeWorker } = await import(`${APP_DIR}/app/lib/theme-worker.server.js`);

// Tokens are injected so the worker never reaches shopify.server.js (and its
// OAuth/session machinery). The stored, encrypted fallback is what a real
// pasted custom-app token degrades to anyway.
const createTokens = ({ fallbackToken }) => ({
  async get() { return fallbackToken || "harness-token"; },
  invalidate() {},
  get didRefresh() { return false; },
});

process.send?.({ type: "ready" });
await runThemeWorker(jobId, { createTokens });
process.send?.({ type: "done" });
process.exit(0);
