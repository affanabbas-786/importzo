// app/utils/encryption.server.js
// AES-256-CBC encryption for sensitive values (e.g. access tokens in DB).
// Requires ENCRYPTION_KEY env var (any string — hashed to 32 bytes internally).

import crypto from "crypto";

const ALGORITHM = "aes-256-cbc";

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!raw) {
    console.warn("[importzo] ENCRYPTION_KEY is not set — tokens will not be encrypted");
    return null;
  }
  // Hash to exactly 32 bytes regardless of input length
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns "<ivHex>:<cipherHex>" or the original value if key is missing.
 */
export function encrypt(text) {
  if (!text) return text;
  const key = getKey();
  if (!key) return text; // no key — store plaintext (with warning above)
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let enc = cipher.update(String(text), "utf8", "hex");
    enc += cipher.final("hex");
    return iv.toString("hex") + ":" + enc;
  } catch (err) {
    console.warn("[importzo] encrypt error:", err?.message);
    return text;
  }
}

/**
 * Decrypt a value previously encrypted with encrypt().
 * Returns the original plaintext, or the raw value if it was never encrypted.
 */
export function decrypt(text) {
  if (!text) return text;
  // Values without ":" were stored before encryption was introduced — return as-is.
  if (!text.includes(":")) return text;
  const key = getKey();
  if (!key) return text;
  try {
    const colonIdx = text.indexOf(":");
    const ivHex = text.slice(0, colonIdx);
    const enc = text.slice(colonIdx + 1);
    if (ivHex.length !== 32) return text; // not an encrypted value
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let dec = decipher.update(enc, "hex", "utf8");
    dec += decipher.final("utf8");
    return dec;
  } catch {
    // Decryption failed — value may be legacy plaintext containing a colon (e.g. shpat_ tokens)
    return text;
  }
}
