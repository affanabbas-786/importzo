import sodium from "libsodium.js";

// eslint-disable-next-line no-undef
const SECRET_KEY = process.env.SHOPIFY_API_SECRET;

if (!SECRET_KEY) {
  throw new Error("SHOPIFY_API_SECRET not set - cannot encrypt credentials");
}

// Derive a fixed 32-byte key from the secret
const getEncryptionKey = async () => {
  // eslint-disable-next-line no-undef
  const key = await sodium.crypto_hash_sha256(Buffer.from(SECRET_KEY));
  return key.slice(0, 32); // Take first 32 bytes
};

export async function encryptToken(plaintext) {
  if (!plaintext) return null;

  const key = await getEncryptionKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  // eslint-disable-next-line no-undef
  const ciphertext = sodium.crypto_secretbox_easy(
    Buffer.from(plaintext),
    nonce,
    key
  );

  // Return base64 encoded nonce + ciphertext
  // eslint-disable-next-line no-undef
  const combined = Buffer.concat([nonce, ciphertext]);
  return combined.toString("base64");
}

export async function decryptToken(encrypted) {
  if (!encrypted) return null;

  try {
    const key = await getEncryptionKey();
    // eslint-disable-next-line no-undef
    const combined = Buffer.from(encrypted, "base64");
    const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
    // eslint-disable-next-line no-undef
    return Buffer.from(plaintext).toString("utf8");
  } catch (err) {
    console.error("Token decryption failed:", err.message);
    throw new Error("Failed to decrypt stored credentials");
  }
}
