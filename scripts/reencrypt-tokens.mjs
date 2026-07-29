#!/usr/bin/env node
// Upgrades stored access tokens to the current AES-256-GCM format.
//
// Existing rows may hold tokens in one of two legacy forms:
//   • AES-256-CBC  — written before Phase 3 (unauthenticated cipher)
//   • PLAINTEXT    — written whenever ENCRYPTION_KEY was unset, because
//                    encrypt() used to fail open and return its input
//
// Both are still readable, so the app works without running this. Running
// it re-seals them with the authenticated cipher, which is the point of
// the "encrypted at rest, not plaintext" requirement.
//
// Usage:
//   node scripts/reencrypt-tokens.mjs --dry-run    # report only, no writes
//   node scripts/reencrypt-tokens.mjs              # apply
//
// Safe to re-run: rows already in the current format are skipped.
// Take a database backup first regardless — this rewrites credentials.

import { PrismaClient } from "@prisma/client";
import { encrypt, decrypt, needsReencryption, validateEncryptionKey } from "../app/utils/encryption.server.js";

const DRY_RUN = process.argv.includes("--dry-run");

// Every model/field pair holding a token.
const TOKEN_FIELDS = [
  { model: "sourceStore", fields: ["token"] },
  { model: "transferSession", fields: ["sourceToken", "destToken"] },
  { model: "migrationJob", fields: ["sourceToken", "destToken"] },
  { model: "scheduledSync", fields: ["sourceToken", "destToken"] },
];

async function main() {
  const { valid, error } = validateEncryptionKey();
  if (!valid) {
    console.error(`\n✗ Cannot run: ${error}\n`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const totals = { scanned: 0, upgraded: 0, alreadyCurrent: 0, failed: 0 };

  console.log(DRY_RUN ? "\nDRY RUN — no writes will be made.\n" : "\nRe-encrypting tokens…\n");

  for (const { model, fields } of TOKEN_FIELDS) {
    let rows;
    try {
      rows = await prisma[model].findMany();
    } catch (err) {
      console.warn(`  ${model}: skipped (${err.message})`);
      continue;
    }

    let upgraded = 0, current = 0, failed = 0;

    for (const row of rows) {
      const data = {};

      for (const field of fields) {
        const value = row[field];
        totals.scanned++;

        if (!needsReencryption(value)) { current++; totals.alreadyCurrent++; continue; }

        try {
          // decrypt() transparently handles CBC and plaintext; encrypt()
          // always writes the current format.
          const plaintext = decrypt(value);
          data[field] = encrypt(plaintext);
          upgraded++;
          totals.upgraded++;
        } catch (err) {
          // Most likely a value written under a different ENCRYPTION_KEY.
          // Leave it alone: overwriting would destroy any chance of
          // recovery, and the affected store can simply reconnect.
          console.warn(`  ${model}#${row.id}.${field}: LEFT AS-IS — ${err.message}`);
          failed++;
          totals.failed++;
        }
      }

      if (Object.keys(data).length && !DRY_RUN) {
        await prisma[model].update({ where: { id: row.id }, data });
      }
    }

    console.log(`  ${model.padEnd(18)} ${rows.length} row(s): ${upgraded} to upgrade, ${current} already current, ${failed} failed`);
  }

  await prisma.$disconnect();

  console.log("\n─────────────────────────────────────────");
  console.log(`  scanned:         ${totals.scanned}`);
  console.log(`  ${DRY_RUN ? "would upgrade:  " : "upgraded:       "} ${totals.upgraded}`);
  console.log(`  already current: ${totals.alreadyCurrent}`);
  console.log(`  failed:          ${totals.failed}`);
  console.log("─────────────────────────────────────────\n");

  if (totals.failed > 0) {
    console.warn("Some tokens could not be decrypted — they were written under a different key.");
    console.warn("Those stores must reconnect. Nothing was overwritten.\n");
  }
  if (DRY_RUN && totals.upgraded > 0) {
    console.log("Re-run without --dry-run to apply. Back up the database first.\n");
  }
}

main().catch((err) => {
  console.error("\n✗ Re-encryption failed:", err);
  process.exit(1);
});
