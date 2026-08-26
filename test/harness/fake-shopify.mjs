// Offline stand-in for Shopify's REST Admin API, good enough to drive
// theme-worker.server.js end to end over real sockets.
//
// Deliberately a real HTTPS server rather than a stubbed global.fetch: the
// worker's whole request layer (shopifyFetch's retry/pacing/concurrency cap)
// stays in the path, and a SIGKILLed child really does drop a connection
// mid-flight the way a PM2 restart does.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TLS = {
  key: fs.readFileSync(path.join(HERE, "certs/key.pem")),
  cert: fs.readFileSync(path.join(HERE, "certs/cert.pem")),
};

const RATE_HEADERS = { "X-Shopify-Shop-Api-Call-Limit": "1/40" };

function send(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...RATE_HEADERS, ...extra });
  res.end(payload);
}

/**
 * SOURCE store: serves a theme manifest and its assets.
 *
 * `assets` is { key -> string content }. `onAssetRequest` is called with each
 * key BEFORE the response is produced, so a scenario can stall or count.
 */
export async function startSourceStore({ themeId = "111", assets, onAssetRequest = null } = {}) {
  const keys = Object.keys(assets);
  const state = { assetRequests: [], manifestRequests: 0 };

  const server = https.createServer(TLS, async (req, res) => {
    const url = new URL(req.url, "https://127.0.0.1");
    const assetKey = url.searchParams.get("asset[key]");

    if (url.pathname === `/admin/api/2026-04/themes/${themeId}/assets.json` && !assetKey) {
      state.manifestRequests++;
      return send(res, 200, { assets: keys.map((key) => ({ key })) });
    }

    if (url.pathname === `/admin/api/2026-04/themes/${themeId}/assets.json` && assetKey) {
      state.assetRequests.push(assetKey);
      if (onAssetRequest) {
        // A scenario may never resolve this — that is how "killed mid-asset"
        // is produced without racing a timer.
        const verdict = await onAssetRequest(assetKey, state);
        if (verdict === "fail") return send(res, 500, { errors: "boom" });
      }
      if (assets[assetKey] === undefined) return send(res, 404, { errors: "not found" });
      return send(res, 200, { asset: { key: assetKey, value: assets[assetKey] } });
    }

    return send(res, 404, { errors: `unrouted ${req.method} ${url.pathname}` });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, state, themeId, shop: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * DESTINATION store: theme list (the adoption check), create, and the
 * processing poll.
 *
 * `themes` starts as whatever a scenario pre-seeds — pre-seeding a theme
 * named exactly targetThemeName is how the adoption path is exercised.
 */
export async function startDestStore({ themes = [], processingPolls = 0, onCreate = null } = {}) {
  const state = { themes: [...themes], creates: [], listRequests: 0, polls: {}, nextId: 900 };

  const server = https.createServer(TLS, async (req, res) => {
    const url = new URL(req.url, "https://127.0.0.1");
    const m = url.pathname.match(/^\/admin\/api\/2026-04\/themes(?:\/(\d+))?\.json$/);

    if (m && !m[1] && req.method === "GET") {
      state.listRequests++;
      return send(res, 200, { themes: state.themes });
    }

    if (m && !m[1] && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const theme = JSON.parse(raw).theme;
      // The theme is registered BEFORE onCreate runs, so a hook that never
      // resolves reproduces the one genuinely dangerous window in this
      // pipeline: Shopify has created the theme, but the job has not yet been
      // told its id.
      const created = { id: state.nextId++, name: theme.name, role: theme.role, processing: true };
      state.themes.push(created);
      state.creates.push({ name: theme.name, src: theme.src, role: theme.role, id: created.id });
      if (onCreate) await onCreate(created, state);
      return send(res, 200, { theme: created });
    }

    if (m && m[1] && req.method === "GET") {
      const id = m[1];
      const theme = state.themes.find((t) => String(t.id) === id);
      if (!theme) return send(res, 404, { errors: "not found" });
      state.polls[id] = (state.polls[id] || 0) + 1;
      // Report `processing: false` only after the configured number of polls,
      // so EXTRACTING is genuinely a poll loop and not a single call.
      const done = state.polls[id] > processingPolls;
      return send(res, 200, { theme: { ...theme, processing: !done } });
    }

    return send(res, 404, { errors: `unrouted ${req.method} ${url.pathname}` });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, state, shop: `127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
