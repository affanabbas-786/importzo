// Refuses to let a non-production process talk to the production database.
//
// The server's .env carries DATABASE_URL=file:./production.sqlite alongside
// NODE_ENV=production. Copy that file to a dev machine — the same mistake the
// NODE_ENV/billing guard in shopify.server.js exists for — and `npm run dev`
// points Prisma at the live database holding every merchant's OAuth tokens,
// sessions and import history. `prisma migrate deploy` in the dev command would
// then apply migrations to it.
//
// Kept dependency-free and free of extensionless imports on purpose: this runs
// both inside the bundled app (db.server.js) and as a plain node script before
// the dev server boots (scripts/assert-dev-database.mjs), where no bundler
// resolution is available.

// Matched against the URL rather than a resolved path because that is the exact
// string Prisma acts on. Any file whose name or directory says "production" is
// treated as production — a false positive on a deliberately-named local file
// is a cheap inconvenience next to what a false negative costs.
const PRODUCTION_DB_PATTERN = /production/i;

export function isProductionDatabaseUrl(databaseUrl) {
  return Boolean(databaseUrl) && PRODUCTION_DB_PATTERN.test(databaseUrl);
}

/**
 * Throws when a non-production environment is aimed at the production database.
 *
 * `nodeEnv` of undefined counts as non-production: an unset NODE_ENV is never
 * the production process (PM2 pins it in ecosystem.importzo.config.cjs), so the
 * safe reading of "unset" is "not production".
 */
export function assertDatabaseMatchesEnv({ nodeEnv, databaseUrl, context = "This process" }) {
  if (nodeEnv === "production") return;
  if (!isProductionDatabaseUrl(databaseUrl)) return;

  throw new Error(
    `[importzo] FATAL: ${context} is running with NODE_ENV=${nodeEnv ?? "(unset)"} ` +
    `but DATABASE_URL points at the production database (${databaseUrl}). ` +
    `Refusing to continue: this would read and write live merchant data, and ` +
    `\`prisma migrate deploy\` would migrate it. Use .env.development.example as the ` +
    `template for a local .env (DATABASE_URL=file:./dev.sqlite); the production .env ` +
    `belongs only on the server.`
  );
}
