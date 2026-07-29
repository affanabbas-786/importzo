import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  encrypt, decrypt, isEncrypted, isLegacyCbc, needsReencryption,
  validateEncryptionKey, assertEncryptionConfigured, EncryptionConfigError,
} from "./encryption.server.js";

const GOOD_KEY = "a-sufficiently-long-and-random-encryption-key-for-tests-0123456789";
const SHOPIFY_TOKEN = "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";

let original;
beforeEach(() => {
  original = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = GOOD_KEY;
});
afterEach(() => {
  if (original === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = original;
});

// Builds a value in the old AES-256-CBC format, to prove existing rows
// written before this change are still readable.
function legacyCbcEncrypt(text, rawKey = GOOD_KEY) {
  const key = crypto.createHash("sha256").update(rawKey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let enc = cipher.update(String(text), "utf8", "hex");
  enc += cipher.final("hex");
  return `${iv.toString("hex")}:${enc}`;
}

describe("validateEncryptionKey", () => {
  it("accepts a strong key", () => {
    expect(validateEncryptionKey(GOOD_KEY)).toEqual({ valid: true, error: null });
  });

  it("rejects a missing key with actionable guidance", () => {
    const result = validateEncryptionKey("");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not set/i);
    expect(result.error).toMatch(/openssl rand/); // tells you how to fix it
  });

  it("rejects a key that is too short", () => {
    const result = validateEncryptionKey("short");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too short/i);
  });

  it("rejects a long but entropy-free placeholder", () => {
    const result = validateEncryptionKey("x".repeat(64));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no entropy/i);
  });

  it("never echoes the key back in an error message", () => {
    // Distinctive values that can't coincidentally appear in the wording.
    for (const key of ["s3cr3tk3yv4lu3", "Q".repeat(64)]) {
      expect(validateEncryptionKey(key).error).not.toContain(key);
    }
  });
});

describe("encrypt", () => {
  it("round-trips a token", () => {
    expect(decrypt(encrypt(SHOPIFY_TOKEN))).toBe(SHOPIFY_TOKEN);
  });

  it("produces the versioned v2 format", () => {
    const enc = encrypt(SHOPIFY_TOKEN);
    expect(enc.startsWith("v2:")).toBe(true);
    expect(enc.split(":")).toHaveLength(4); // v2:iv:tag:cipher
    expect(isEncrypted(enc)).toBe(true);
  });

  it("never leaves the plaintext visible in the stored value", () => {
    expect(encrypt(SHOPIFY_TOKEN)).not.toContain(SHOPIFY_TOKEN);
    expect(encrypt(SHOPIFY_TOKEN)).not.toContain("shpat_");
  });

  it("uses a fresh IV each time, so identical tokens don't produce identical ciphertext", () => {
    // Otherwise an attacker with DB read access could tell which shops
    // share a token, and spot when one changes.
    expect(encrypt(SHOPIFY_TOKEN)).not.toBe(encrypt(SHOPIFY_TOKEN));
  });

  // ── The core fail-open fix ──
  it("THROWS instead of silently storing plaintext when the key is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt(SHOPIFY_TOKEN)).toThrow(EncryptionConfigError);
  });

  it("throws rather than returning the input when the key is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    // The old behavior returned the plaintext, which then got written to
    // the database. Assert explicitly that this can no longer happen.
    let returned;
    try { returned = encrypt(SHOPIFY_TOKEN); } catch { /* expected */ }
    expect(returned).toBeUndefined();
  });

  it("throws when the key is present but too weak to be usable", () => {
    process.env.ENCRYPTION_KEY = "weak";
    expect(() => encrypt(SHOPIFY_TOKEN)).toThrow(EncryptionConfigError);
  });

  it("passes through empty values untouched, without requiring a key", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(encrypt("")).toBe("");
    expect(encrypt(null)).toBeNull();
    expect(encrypt(undefined)).toBeUndefined();
  });
});

describe("decrypt", () => {
  it("detects tampering via the GCM auth tag", () => {
    const enc = encrypt(SHOPIFY_TOKEN);
    const [v, iv, tag, cipher] = enc.split(":");
    // Flip one ciphertext character.
    const flipped = cipher[0] === "a" ? "b" : "a";
    const tampered = [v, iv, tag, flipped + cipher.slice(1)].join(":");

    // CBC would have decrypted this to garbage silently; GCM rejects it.
    expect(() => decrypt(tampered)).toThrow(EncryptionConfigError);
  });

  it("rejects a value encrypted under a different key rather than returning ciphertext", () => {
    const enc = encrypt(SHOPIFY_TOKEN);
    process.env.ENCRYPTION_KEY = "a-completely-different-key-that-is-also-long-enough-9876543210";

    // The old version returned the raw ciphertext here, which surfaced much
    // later as a confusing Shopify auth failure.
    expect(() => decrypt(enc)).toThrow(/ENCRYPTION_KEY may have changed/i);
  });

  it("throws on a malformed v2 value", () => {
    expect(() => decrypt("v2:onlytwo")).toThrow(EncryptionConfigError);
  });

  it("passes through empty values", () => {
    expect(decrypt("")).toBe("");
    expect(decrypt(null)).toBeNull();
    expect(decrypt(undefined)).toBeUndefined();
  });

  describe("backward compatibility with existing database rows", () => {
    it("still reads legacy AES-256-CBC values", () => {
      const legacy = legacyCbcEncrypt(SHOPIFY_TOKEN);
      expect(isLegacyCbc(legacy)).toBe(true);
      expect(decrypt(legacy)).toBe(SHOPIFY_TOKEN);
    });

    it("still reads legacy plaintext written while the fail-open path was active", () => {
      // These exist in production precisely because encrypt() used to
      // return plaintext when no key was configured.
      expect(decrypt(SHOPIFY_TOKEN)).toBe(SHOPIFY_TOKEN);
    });

    it("does not mistake a plaintext token containing a colon for CBC ciphertext", () => {
      const weird = "shpat_abc:def:ghi";
      expect(isLegacyCbc(weird)).toBe(false);
      expect(decrypt(weird)).toBe(weird);
    });

    it("returns a CBC-shaped value unchanged when it cannot actually be decrypted", () => {
      // Correctly-shaped hex that isn't real ciphertext — treat as plaintext
      // rather than throwing, since legacy data is unpredictable.
      const shaped = `${"a".repeat(32)}:${"b".repeat(32)}`;
      expect(decrypt(shaped)).toBe(shaped);
    });

    // ── The legacy path must fail closed on config errors too ──
    //
    // getKey() used to be called inside the CBC try block, so a missing key
    // was caught by the same catch that implements the plaintext fallback,
    // and decrypt() handed back raw ciphertext as if it were a token. That is
    // the fail-open bug this module exists to remove, surviving on the legacy
    // path after the v2 path was fixed.
    it("throws on a legacy CBC value when the key is missing, instead of returning ciphertext", () => {
      const legacy = legacyCbcEncrypt(SHOPIFY_TOKEN);
      delete process.env.ENCRYPTION_KEY;

      expect(() => decrypt(legacy)).toThrow(EncryptionConfigError);
    });

    it("throws on a legacy CBC value when the key is too weak to be usable", () => {
      const legacy = legacyCbcEncrypt(SHOPIFY_TOKEN);
      process.env.ENCRYPTION_KEY = "weak";

      expect(() => decrypt(legacy)).toThrow(EncryptionConfigError);
    });

    it("never returns the ciphertext itself when the key is missing", () => {
      const legacy = legacyCbcEncrypt(SHOPIFY_TOKEN);
      delete process.env.ENCRYPTION_KEY;

      // Assert the specific old failure mode: a caller must not receive the
      // stored value back and mistake it for a usable token.
      let returned;
      try { returned = decrypt(legacy); } catch { /* expected */ }
      expect(returned).toBeUndefined();
    });

    it("still reads plaintext without a key, since no key is needed for it", () => {
      // The plaintext fallback is not a config-error path — don't over-correct
      // and break reads of rows the old fail-open encrypt() wrote.
      delete process.env.ENCRYPTION_KEY;

      expect(decrypt(SHOPIFY_TOKEN)).toBe(SHOPIFY_TOKEN);
    });
  });
});

describe("format detection", () => {
  it("isEncrypted only matches the current format", () => {
    expect(isEncrypted(encrypt(SHOPIFY_TOKEN))).toBe(true);
    expect(isEncrypted(legacyCbcEncrypt(SHOPIFY_TOKEN))).toBe(false);
    expect(isEncrypted(SHOPIFY_TOKEN)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it("needsReencryption flags legacy rows and only legacy rows", () => {
    expect(needsReencryption(encrypt(SHOPIFY_TOKEN))).toBe(false);
    expect(needsReencryption(legacyCbcEncrypt(SHOPIFY_TOKEN))).toBe(true);
    expect(needsReencryption(SHOPIFY_TOKEN)).toBe(true); // plaintext
    expect(needsReencryption("")).toBe(false);
    expect(needsReencryption(null)).toBe(false);
  });
});

describe("assertEncryptionConfigured", () => {
  it("passes with a good key", () => {
    expect(assertEncryptionConfigured()).toBe(true);
  });

  it("throws when unset, so a misconfigured deploy fails at boot rather than at first write", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => assertEncryptionConfigured()).toThrow(EncryptionConfigError);
  });

  it("throws on a weak key", () => {
    process.env.ENCRYPTION_KEY = "tooshort";
    expect(() => assertEncryptionConfigured()).toThrow(EncryptionConfigError);
  });
});

describe("upgrade path", () => {
  it("re-encrypting a legacy value yields the current format with the same plaintext", () => {
    const legacy = legacyCbcEncrypt(SHOPIFY_TOKEN);
    const upgraded = encrypt(decrypt(legacy));

    expect(isEncrypted(upgraded)).toBe(true);
    expect(decrypt(upgraded)).toBe(SHOPIFY_TOKEN);
    expect(needsReencryption(upgraded)).toBe(false);
  });

  it("re-encrypting legacy plaintext yields the current format", () => {
    const upgraded = encrypt(decrypt(SHOPIFY_TOKEN));
    expect(isEncrypted(upgraded)).toBe(true);
    expect(decrypt(upgraded)).toBe(SHOPIFY_TOKEN);
  });
});
