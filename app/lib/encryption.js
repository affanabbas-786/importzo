import sodium from "libsodium.js";

// Use app's Shopify API secret as encryption key
const SECRET_KEY = process.env.SHOPIFY_API_SECRET;

if (!SECRET_KEY) {
  throw new Error("SHOPIFY_API_SECRET not set - cannot encrypt credentials");
}

// Derive a fixed 32-byte key from the secret
const getEncryptionKey = async () => {
  const key = await sodium.crypto_hash_sha256(Buffer.from(SECRET_KEY));
  return key.slice(0, 32); // Take first 32 bytes
};

export async function encryptToken(plaintext) {
  if (!plaintext) return null;

  const key = await getEncryptionKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(
    Buffer.from(plaintext),
    nonce,
    key
  );

  // Return base64 encoded nonce + ciphertext
  const combined = Buffer.concat([nonce, ciphertext]);
  return combined.toString("base64");
}

export async function decryptToken(encrypted) {
  if (!encrypted) return null;

  try {
    const key = await getEncryptionKey();
    const combined = Buffer.from(encrypted, "base64");
    const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
    return Buffer.from(plaintext).toString("utf8");
  } catch (err) {
    console.error("Token decryption failed:", err.message);
    throw new Error("Failed to decrypt stored credentials");
  }
}
