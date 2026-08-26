// Shared harness wiring. Nothing here touches the production database or a
// real store: DATABASE_URL points at a throwaway SQLite file and TMPDIR is
// redirected so theme staging/ZIPs land inside the scratchpad.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, "../..");
export const DB_URL = "file:" + path.join(HERE, "harness.sqlite");
export const TMP_DIR = path.join(HERE, "tmp");
// 32+ chars of entropy: encryption.server.js rejects anything weaker.
export const ENCRYPTION_KEY = "harness-only-key-0123456789abcdef0123456789";

export const childEnv = (extra = {}) => ({
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: DB_URL,
  ENCRYPTION_KEY,
  TMPDIR: TMP_DIR,
  SHOPIFY_APP_URL: "https://harness.invalid",
  // The fake stores present a self-signed cert for 127.0.0.1.
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  ...extra,
});
