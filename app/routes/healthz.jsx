// Public health check — no Shopify authentication required.
//
// This is the target for external uptime monitoring (UptimeRobot or
// equivalent). It must stay cheap and dependency-light: one trivial DB
// round-trip plus process metadata. A future outage should be caught here
// within minutes rather than discovered via Shopify's merchant-facing
// app-quality warning email (see the 2026-09-01 / 2026-09-03 incidents).
//
// Resource route: no default export, so it renders no UI — the loader's
// Response is returned verbatim.
import prisma from "../db.server";

// Captured once at module load = when this server process started.
const PROCESS_STARTED_AT = Date.now();

export const loader = async () => {
  const checks = { db: "unknown" };
  let ok = true;

  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    checks.db = "ok";
  } catch (err) {
    checks.db = "error";
    ok = false;
    console.error("[importzo] /healthz: DB check failed:", err?.message);
  }

  const body = {
    status: ok ? "ok" : "error",
    uptimeSeconds: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
    pid: process.pid, // eslint-disable-line no-undef
    timestamp: new Date().toISOString(),
    checks,
  };

  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};
