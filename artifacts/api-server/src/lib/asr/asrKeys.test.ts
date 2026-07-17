import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getProviderDef,
  getStoredAsrKey,
  setStoredAsrKey,
  clearStoredAsrKey,
  getAsrKeySource,
  resolveAsrApiKey,
  isProviderConfigured,
} from "./index";

// These tests hit the real dev DB (same as the rest of the api-server suite)
// using the "deepgram" slot, and clean up after themselves.
const PROVIDER = "deepgram";
const ROW = `asr_${PROVIDER}`;
const ENV_KEY = "DEEPGRAM_API_KEY";
const originalEnv = process.env[ENV_KEY];

async function cleanup(): Promise<void> {
  await db.delete(appCredentialsTable).where(eq(appCredentialsTable.provider, ROW));
}

beforeEach(async () => {
  delete process.env[ENV_KEY];
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe("ASR key storage and resolution", () => {
  const def = getProviderDef(PROVIDER)!;

  it("returns null when no key is stored anywhere", async () => {
    expect(await getStoredAsrKey(PROVIDER)).toBeNull();
    expect(await getAsrKeySource(def)).toBeNull();
    expect(await resolveAsrApiKey(def)).toBeNull();
    expect(await isProviderConfigured(def)).toBe(false);
  });

  it("stores the key encrypted and round-trips it", async () => {
    await setStoredAsrKey(PROVIDER, "dg-secret-123");
    const row = (
      await db
        .select()
        .from(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, ROW))
    )[0];
    expect(row).toBeDefined();
    expect(row!.encryptedCredentials).not.toContain("dg-secret-123");
    expect(await getStoredAsrKey(PROVIDER)).toBe("dg-secret-123");
    expect(await getAsrKeySource(def)).toBe("database");
    expect(await isProviderConfigured(def)).toBe(true);
  });

  it("prefers the stored key over the env secret", async () => {
    process.env[ENV_KEY] = "env-key";
    expect(await getAsrKeySource(def)).toBe("env");
    expect(await resolveAsrApiKey(def)).toBe("env-key");

    await setStoredAsrKey(PROVIDER, "db-key");
    expect(await getAsrKeySource(def)).toBe("database");
    expect(await resolveAsrApiKey(def)).toBe("db-key");
  });

  it("falls back to the env secret after the stored key is cleared", async () => {
    process.env[ENV_KEY] = "env-key";
    await setStoredAsrKey(PROVIDER, "db-key");
    await clearStoredAsrKey(PROVIDER);
    expect(await getStoredAsrKey(PROVIDER)).toBeNull();
    expect(await getAsrKeySource(def)).toBe("env");
    expect(await resolveAsrApiKey(def)).toBe("env-key");
  });

  it("overwrites an existing stored key", async () => {
    await setStoredAsrKey(PROVIDER, "first");
    await setStoredAsrKey(PROVIDER, "second");
    expect(await getStoredAsrKey(PROVIDER)).toBe("second");
  });

  it("never reports a key source for the built-in OpenAI provider", async () => {
    const openaiDef = getProviderDef("openai")!;
    expect(await getAsrKeySource(openaiDef)).toBeNull();
    expect(await resolveAsrApiKey(openaiDef)).toBeNull();
    expect(await isProviderConfigured(openaiDef)).toBe(true);
  });
});
