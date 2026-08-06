// Pre-boot gate for the dev server. Wired into shopify.web.toml's dev command,
// ahead of `prisma migrate deploy`.
//
// The runtime guard in app/db.server.js cannot cover this: `prisma migrate
// deploy` runs as its own process before node ever boots the app, so by the
// time any JS guard could fire, migrations would already have been applied to
// whatever DATABASE_URL points at.
//
// This script deliberately does NOT consult NODE_ENV. It is only ever invoked
// from the dev command, so "this is a dev run" is a given — and reading
// NODE_ENV here would reintroduce the exact ordering trap this is meant to
// close, since the Shopify CLI merges .env (NODE_ENV=production, on a .env
// copied from the server) into the environment it spawns this command with.

import { existsSync, readFileSync } from "node:fs";
import { assertDatabaseMatchesEnv } from "../app/lib/database-guard.js";

// The Shopify CLI injects .env into this process, but the file is read directly
// as a fallback so the check still holds when the script is run on its own.
function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(".env")) return undefined;

  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

try {
  assertDatabaseMatchesEnv({
    nodeEnv: "development", // see above: dev is a given here, not something to detect
    databaseUrl: readDatabaseUrl(),
    context: "The dev server",
  });
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
