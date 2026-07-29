// app/utils/encryption.server.js
// Field-level encryption for access tokens at rest.
//
// ═══════════════════════════════════════════════════════════════════
// Phase 3 hardening. Four problems with the previous implementation:
//
// 1. FAIL-OPEN. With ENCRYPTION_KEY unset, encrypt() logged a warning and
//    returned the plaintext, which was then written to the database. Every
//    OAuth token in SourceStore, TransferSession, MigrationJob and
//    ScheduledSync would sit in the clear while the code read as if it
//    were encrypting. A security control that silently doesn't apply is
//    worse than none, because nothing surfaces it.
//
// 2. UNAUTHENTICATED CIPHER. AES-256-CBC provides confidentiality but no
//    integrity: ciphertext can be altered without detection. Tokens are
//    now sealed with AES-256-GCM, whose auth tag makes tampering fail
//    loudly instead of decrypting to garbage.
//
// 3. NO KEY VALIDATION. Any non-empty string was accepted, including "x".
//    The key is now required to carry a plausible amount of entropy.
//
// 4. ERRORS SWALLOWED. decrypt() returned the raw input on any failure, so
//    a wrong key silently produced a "token" that was really ciphertext,
//    surfacing later as a confusing Shopify auth error rather than a
//    configuration error.
//
// Storage format (versioned so this can evolve again):
//     v2:<ivHex>:<authTagHex>:<cipherHex>     AES-256-GCM  (written today)
//     <ivHex>:<cipherHex>                     AES-256-CBC  (legacy, read-only)
//     <anything else>                         plaintext    (legacy, read-only)
//
// Both legacy forms remain READABLE so existing rows keep working, but
// nothing new is ever written in them. See reencryptAll() in
// scripts/reencrypt-tokens.mjs for upgrading rows in place.
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

const GCM_ALGORITHM = "aes-256-gcm";
const LEGACY_CBC_ALGORITHM = "aes-256-cbc";
const VERSION_PREFIX = "v2";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const MIN_KEY_LENGTH = 32;

export class EncryptionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

/**
 * Validates the configured key without revealing it.
 * Returns { valid, error } rather than throwing, so a startup check can
 * report the problem in context.
 */
export function validateEncryptionKey(raw = process.env.ENCRYPTION_KEY) {
  if (!raw) {
    return {
      valid: false,
      error:
        "ENCRYPTION_KEY is not set. Access tokens cannot be encrypted at rest. " +
        "Generate one with: openssl rand -base64 48",
    };
  }
  if (raw.length < MIN_KEY_LENGTH) {
    return {
      valid: false,
      error:
        `ENCRYPTION_KEY is too short (${raw.length} chars, minimum ${MIN_KEY_LENGTH}). ` +
        "Generate a strong one with: openssl rand -base64 48",
    };
  }
  // Catch placeholder values that meet the length bar but carry no entropy.
  if (/^(.)\1+$/.test(raw)) {
    return { valid: false, error: "ENCRYPTION_KEY has no entropy (all one repeated character)." };
  }
  return { valid: true, error: null };
}

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  const { valid, error } = validateEncryptionKey(raw);
  if (!valid) throw new EncryptionConfigError(error);
  // SHA-256 to exactly 32 bytes regardless of input length.
  return crypto.createHash("sha256").update(raw).digest();
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(`${VERSION_PREFIX}:`);
}

/** True for the pre-Phase-3 CBC format: 32 hex chars, a colon, then hex. */
export function isLegacyCbc(value) {
  return typeof value === "string" && /^[0-9a-f]{32}:[0-9a-f]+$/i.test(value);
}

/**
 * Encrypts a value with AES-256-GCM.
 *
 * THROWS when ENCRYPTION_KEY is missing or weak — deliberately. The old
 * behavior (return plaintext, log a warning) meant a misconfigured deploy
 * wrote unencrypted tokens indefinitely with nothing to notice it. Failing
 * here means the problem surfaces at the moment of the first write.
 */
export function encrypt(text) {
  if (text === null || text === undefined || text === "") return text;

  const key = getKey(); // throws EncryptionConfigError when unusable
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);

  let enc = cipher.update(String(text), "utf8", "hex");
  enc += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${VERSION_PREFIX}:${iv.toString("hex")}:${authTag}:${enc}`;
}

/**
 * Decrypts a stored value, transparently handling all three historical
 * formats so existing rows keep working.
 *
 * Throws on a value that IS encrypted but cannot be decrypted (wrong key,
 * tampering, corruption). That's a real failure and must not be mistaken
 * for a valid token — the previous version returned the raw ciphertext,
 * which surfaced much later as a baffling Shopify auth error.
 */
export function decrypt(text) {
  if (text === null || text === undefined || text === "") return text;
  const value = String(text);

  if (isEncrypted(value)) {
    const parts = value.split(":");
    // v2:iv:tag:cipher
    if (parts.length !== 4) {
      throw new EncryptionConfigError("Encrypted value is malformed (expected v2:iv:tag:ciphertext).");
    }
    const [, ivHex, tagHex, cipherHex] = parts;
    try {
      const decipher = crypto.createDecipheriv(GCM_ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      let dec = decipher.update(cipherHex, "hex", "utf8");
      dec += decipher.final("utf8"); // GCM verifies the auth tag here
      return dec;
    } catch (err) {
      if (err instanceof EncryptionConfigError) throw err;
      throw new EncryptionConfigError(
        "Failed to decrypt a stored token. The ENCRYPTION_KEY may have changed since it was " +
        "written, or the value was tampered with. Tokens encrypted with a previous key cannot " +
        "be recovered and the affected stores must reconnect.",
      );
    }
  }

  if (isLegacyCbc(value)) {
    // Pre-Phase-3 rows. Readable, never written anymore.
    try {
      const colonIdx = value.indexOf(":");
      const iv = Buffer.from(value.slice(0, colonIdx), "hex");
      const decipher = crypto.createDecipheriv(LEGACY_CBC_ALGORITHM, getKey(), iv);
      let dec = decipher.update(value.slice(colonIdx + 1), "hex", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch {
      // A Shopify token can itself contain a colon, so a CBC-shaped string
      // that won't decrypt is most likely legacy plaintext. Returning it
      // as-is is correct here and is why the strict hex test above matters.
      return value;
    }
  }

  // Legacy plaintext, written while the old fail-open path was active.
  return value;
}

/**
 * True when a stored value still needs upgrading to the current format.
 * Used by the re-encryption script and by operational reporting.
 */
export function needsReencryption(value) {
  if (value === null || value === undefined || value === "") return false;
  return !isEncrypted(String(value));
}

/**
 * Startup guard. Call once at boot: better to refuse to start than to run
 * an app that silently cannot protect the tokens it stores.
 */
export function assertEncryptionConfigured() {
  const { valid, error } = validateEncryptionKey();
  if (!valid) throw new EncryptionConfigError(error);
  return true;
}
