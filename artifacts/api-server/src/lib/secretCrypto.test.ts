import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  encryptJson,
  decryptJson,
  maskSecret,
  isEncryptionConfigured,
} from "./secretCrypto";

describe("secretCrypto", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSecret;
    }
  });

  it("round-trips a string through encrypt/decrypt", () => {
    const plaintext = "super-secret-token-value";
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("round-trips a JSON credential object", () => {
    const creds = { pageId: "123", pageAccessToken: "abc-token" };
    const encrypted = encryptJson(creds);
    expect(encrypted).not.toContain("abc-token");
    expect(decryptJson(encrypted)).toEqual(creds);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("fails closed: encryption throws when SESSION_SECRET is absent", () => {
    delete process.env.SESSION_SECRET;
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/SESSION_SECRET/);
    expect(() => encryptJson({ x: 1 })).toThrow(/SESSION_SECRET/);
  });

  it("fails closed: decryption throws when SESSION_SECRET is absent", () => {
    const encrypted = encryptSecret("value");
    delete process.env.SESSION_SECRET;
    expect(() => decryptSecret(encrypted)).toThrow(/SESSION_SECRET/);
  });

  it("detects tampering via the GCM auth tag", () => {
    const encrypted = encryptSecret("value");
    const body = encrypted.replace(/^v1:/, "");
    const [iv, tag, data] = body.split(":");
    // Flip a byte in the ciphertext.
    const bytes = Buffer.from(data, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = `v1:${iv}:${tag}:${bytes.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("not-a-valid-payload")).toThrow(/Malformed/);
  });

  describe("dedicated key migration (dual-read)", () => {
    let originalDedicated: string | undefined;

    beforeEach(() => {
      originalDedicated = process.env.CREDENTIALS_ENCRYPTION_KEY;
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    });

    afterEach(() => {
      if (originalDedicated === undefined) {
        delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      } else {
        process.env.CREDENTIALS_ENCRYPTION_KEY = originalDedicated;
      }
    });

    it("still decrypts a session-secret payload after CREDENTIALS_ENCRYPTION_KEY is enabled", () => {
      // Encrypted while only SESSION_SECRET existed (legacy at-rest payload).
      const legacy = encryptSecret("legacy-value");
      // Operator later enables a dedicated key.
      process.env.CREDENTIALS_ENCRYPTION_KEY = "dedicated-key-value";
      // Fallback keeps the old payload readable...
      expect(decryptSecret(legacy)).toBe("legacy-value");
      // ...and new payloads use the dedicated key (still readable, and not
      // decryptable by the session secret alone).
      const fresh = encryptSecret("fresh-value");
      expect(decryptSecret(fresh)).toBe("fresh-value");
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      expect(() => decryptSecret(fresh)).toThrow();
    });
  });

  describe("maskSecret", () => {
    it("never returns the raw secret and keeps only the last few chars", () => {
      const secret = "topsecretvalue987";
      const masked = maskSecret(secret, 4);
      expect(masked).not.toBe(secret);
      expect(masked).not.toContain("topsecretvalue");
      expect(masked?.endsWith("e987")).toBe(true);
      expect(masked).toContain("\u2022");
    });

    it("returns null for empty input", () => {
      expect(maskSecret(null)).toBeNull();
      expect(maskSecret(undefined)).toBeNull();
      expect(maskSecret("")).toBeNull();
    });

    it("fully masks short values (no visible chars leak)", () => {
      expect(maskSecret("ab", 4)).toBe("\u2022\u2022");
    });
  });
});
