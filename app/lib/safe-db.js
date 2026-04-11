// ═══════════════════════════════════════════════════════════════════
// Importzo — Safe DB Helpers
// Defensive wrappers around Prisma calls that can crash the app if the
// generated client is out of sync with the running schema (e.g. a new
// model added but migrations not yet deployed in production).
//
// Instead of bubbling up a raw TypeError ("Cannot read properties of
// undefined (reading 'findUnique')") to merchants, every call returns
// a safe fallback and logs the underlying issue.
// ═══════════════════════════════════════════════════════════════════

import prisma from "../db.server";
import { encryptToken, decryptToken } from "./encryption.js";

// Ensure the SourceStore table exists at runtime. This is a safety net
// for environments where `prisma migrate deploy` has not yet been run
// against the latest schema — common during the first deploy of a new
// feature. It is a no-op if the table already exists.
let _sourceStoreEnsured = false;
async function ensureSourceStoreTable() {
  if (_sourceStoreEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SourceStore" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "shop" TEXT NOT NULL UNIQUE,
        "sourceUrl" TEXT NOT NULL,
        "sourceName" TEXT NOT NULL DEFAULT '',
        "sourceEmail" TEXT NOT NULL DEFAULT '',
        "sourcePlan" TEXT NOT NULL DEFAULT '',
        "token" TEXT NOT NULL,
        "lastUsed" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    _sourceStoreEnsured = true;
  } catch (err) {
    // Non-fatal — log and continue. The caller will still handle a
    // missing-model error gracefully via the try/catch below.
    console.warn("[importzo] ensureSourceStoreTable failed:", err?.message || err);
  }
}

function hasSourceStoreModel() {
  return !!(prisma && prisma.sourceStore && typeof prisma.sourceStore.findUnique === "function");
}

export async function getSavedSourceStore(shop) {
  try {
    await ensureSourceStoreTable();
    if (!hasSourceStoreModel()) return null;
    const record = await prisma.sourceStore.findUnique({ where: { shop } });
    if (!record) return null;

    // ✅ Decrypt token when retrieving
    const decrypted = await decryptToken(record.token);

    return {
      id: record.id,
      shop: record.shop,
      sourceUrl: record.sourceUrl,
      sourceName: record.sourceName,
      sourceEmail: record.sourceEmail,
      sourcePlan: record.sourcePlan,
      token: decrypted, // Now plaintext only in memory
      lastUsed: record.lastUsed,
      createdAt: record.createdAt,
    };
  } catch (err) {
    console.warn("[importzo] getSavedSourceStore failed:", err?.message || err);
    return null;
  }
}

export async function upsertSourceStore(shop, data) {
  try {
    await ensureSourceStoreTable();
    if (!hasSourceStoreModel()) return null;

    // ✅ Encrypt token before storing
    const encryptedToken = await encryptToken(data.token);

    return await prisma.sourceStore.upsert({
      where: { shop },
      create: {
        shop,
        sourceUrl: data.sourceUrl,
        sourceName: data.sourceName || "",
        sourceEmail: data.sourceEmail || "",
        sourcePlan: data.sourcePlan || "",
        token: encryptedToken,
      },
      update: {
        sourceUrl: data.sourceUrl,
        sourceName: data.sourceName || "",
        sourceEmail: data.sourceEmail || "",
        sourcePlan: data.sourcePlan || "",
        token: encryptedToken,
        lastUsed: new Date(),
      },
    });
  } catch (err) {
    console.warn("[importzo] upsertSourceStore failed:", err?.message || err);
    return null;
  }
}

export async function touchSourceStore(shop) {
  try {
    if (!hasSourceStoreModel()) return null;
    return await prisma.sourceStore.update({
      where: { shop },
      data: { lastUsed: new Date() },
    });
  } catch (err) {
    console.warn("[importzo] touchSourceStore failed:", err?.message || err);
    return null;
  }
}

export async function deleteSourceStore(shop) {
  try {
    if (!hasSourceStoreModel()) return false;
    await prisma.sourceStore.deleteMany({ where: { shop } });
    return true;
  } catch (err) {
    console.warn("[importzo] deleteSourceStore failed:", err?.message || err);
    return false;
  }
}
