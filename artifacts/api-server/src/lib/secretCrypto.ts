import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Symmetric encryption for secrets stored at rest (social credentials, app
 * keys). Uses AES-256-GCM with a key derived from SESSION_SECRET.
 *
 * The stored format is `iv:authTag:ciphertext`, all base64. GCM gives us
 * authenticated encryption so tampering is detected on decrypt.
 *
 * Fails closed: if SESSION_SECRET is absent, encryption/decryption throw rather
 * than silently storing plaintext.
 */
function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to encrypt or decrypt secrets");
  }
  // Derive a fixed 32-byte key regardless of the secret's length.
  return createHash("sha256").update(secret, "utf8").digest();
}

export function isEncryptionConfigured(): boolean {
  return !!process.env.SESSION_SECRET;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString(
    "base64",
  )}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted payload");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Encrypt a JSON-serializable credential object. */
export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

/** Decrypt a credential object previously stored with encryptJson. */
export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}

/**
 * Mask a secret for display: keep the last few characters, replace the rest with
 * bullets. Never returns the raw secret. Returns null for empty input.
 */
export function maskSecret(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null;
  if (value.length <= visible) return "•".repeat(value.length);
  return `${"•".repeat(Math.max(4, value.length - visible))}${value.slice(-visible)}`;
}
