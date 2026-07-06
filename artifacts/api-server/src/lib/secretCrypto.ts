import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Symmetric encryption for secrets stored at rest (social credentials, app
 * keys). Uses AES-256-GCM (authenticated encryption — tampering is detected on
 * decrypt).
 *
 * Key sources, in priority order:
 *   1. CREDENTIALS_ENCRYPTION_KEY — a dedicated at-rest key.
 *   2. SESSION_SECRET — fallback for backward compatibility.
 *
 * New payloads are encrypted with the highest-priority key available. Decryption
 * tries EVERY available key in order (dual-read), so enabling
 * CREDENTIALS_ENCRYPTION_KEY does NOT brick credentials that were previously
 * encrypted under SESSION_SECRET — they keep decrypting via the fallback until
 * they are next written (which re-encrypts them under the dedicated key).
 * Decoupling the credential key from the session/OAuth-state secret means
 * rotating SESSION_SECRET no longer risks stored credentials.
 *
 * Wire format is version-prefixed: `v1:iv:authTag:ciphertext` (all base64 after
 * the prefix). Legacy payloads have no prefix (`iv:authTag:ciphertext`) and are
 * still decryptable.
 *
 * Fails closed: if no key material is available, encryption/decryption throw
 * rather than silently storing plaintext.
 */
const VERSION_PREFIX = "v1:";

const MISSING_KEY_MESSAGE =
  "CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET is required to encrypt or decrypt secrets";

/** Ordered list of candidate secrets: dedicated key first, then session secret. */
function candidateSecrets(): string[] {
  const secrets: string[] = [];
  const dedicated = process.env.CREDENTIALS_ENCRYPTION_KEY;
  const session = process.env.SESSION_SECRET;
  if (dedicated) secrets.push(dedicated);
  if (session && session !== dedicated) secrets.push(session);
  return secrets;
}

/** Derive a fixed 32-byte AES key from a secret of any length. */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function isEncryptionConfigured(): boolean {
  return candidateSecrets().length > 0;
}

export function encryptSecret(plaintext: string): string {
  const secrets = candidateSecrets();
  if (secrets.length === 0) {
    throw new Error(MISSING_KEY_MESSAGE);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secrets[0]), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString(
    "base64",
  )}`;
}

export function decryptSecret(payload: string): string {
  const body = payload.startsWith(VERSION_PREFIX)
    ? payload.slice(VERSION_PREFIX.length)
    : payload;
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted payload");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const secrets = candidateSecrets();
  if (secrets.length === 0) {
    throw new Error(MISSING_KEY_MESSAGE);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch (err) {
      // Wrong key (or tampered payload) — try the next candidate.
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to decrypt payload");
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
