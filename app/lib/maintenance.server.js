// ═══════════════════════════════════════════════════════════════════
// Periodic housekeeping, run from the scheduler tick.
//
// Two retention rules existed in the schema and in code but were never
// actually enforced, because nothing called them:
//
//   • StoreBackup.expiresAt — purgeExpiredBackups() was written in
//     backup.server.js and had tests, but no caller anywhere in the app.
//     Every pre-transfer snapshot (a full JSON copy of the destination's
//     products, collections and metafields) would therefore have been kept
//     forever, growing the SQLite file without bound and holding merchant
//     catalog data long past the retention window the record itself claims.
//
//   • TransferSession.expiresAt — a store-to-store transfer session is
//     created with a 30-MINUTE expiry and holds the SOURCE store's Admin API
//     access token. Expiry was checked on use, but expired rows were never
//     deleted: only "pending" rows for the same source shop were cleared, and
//     only when that shop happened to create a new session. Rows that reached
//     "active" were never cleaned up at all. The live database had sessions
//     from April and June still holding source-store tokens in August.
//
// Both are deletions of data that is by definition already unusable, so this
// is safe to run unattended. Each is independently guarded: housekeeping must
// never be the reason a scheduler tick reports failure.
// ═══════════════════════════════════════════════════════════════════

import { purgeExpiredBackups } from "./backup.server.js";

/**
 * Deletes TransferSession rows whose expiry has passed.
 *
 * The token these rows carry is the whole point: an expired session is
 * already refused by app.transfer-session.jsx, so the row is dead weight that
 * happens to be a live credential for someone else's store. Deleting it is
 * the only thing that actually reduces the blast radius of a database leak.
 */
export async function purgeExpiredTransferSessions(prisma, now = new Date()) {
  if (!prisma?.transferSession?.deleteMany) return { deleted: 0 };
  const { count } = await prisma.transferSession.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return { deleted: count };
}

/**
 * Runs every housekeeping task, isolating failures.
 *
 * Returns a per-task result rather than throwing, so the scheduler tick can
 * report what happened without a purge failure masking (or being mistaken
 * for) a scheduled-sync failure.
 */
export async function runMaintenance({ prisma, now = new Date() } = {}) {
  const results = {};

  try {
    // purgeExpiredBackups returns a bare count, not an object.
    results.backupsPurged = await purgeExpiredBackups(prisma, now);
  } catch (err) {
    console.warn("[maintenance] backup purge failed:", err?.message);
    results.backupsPurged = 0;
    results.backupPurgeError = String(err?.message || err);
  }

  try {
    const { deleted } = await purgeExpiredTransferSessions(prisma, now);
    results.transferSessionsPurged = deleted;
  } catch (err) {
    console.warn("[maintenance] transfer-session purge failed:", err?.message);
    results.transferSessionsPurged = 0;
    results.transferSessionPurgeError = String(err?.message || err);
  }

  if (results.backupsPurged || results.transferSessionsPurged) {
    console.log(
      `[maintenance] purged ${results.backupsPurged} expired backup(s), ` +
      `${results.transferSessionsPurged} expired transfer session(s)`,
    );
  }

  return results;
}
