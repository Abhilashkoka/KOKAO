import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

// Deterministic key resolution: the real dev DB may or may not hold a
// videogen_replicate credential, so stub the shared video-gen key lookup.
const storedKey = { value: null as string | null };
vi.mock("./videoGen", () => ({
  getStoredVideoGenKey: vi.fn(async (provider: string) =>
    provider === "replicate" ? storedKey.value : null,
  ),
}));

import { db, textGenSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  setTextGenSelection,
  resolveReplicateTextKey,
  getReplicateTextKeySource,
  resolveTextModel,
  listTenantModelChoices,
  getTextGenClient,
  TextGenNotConfiguredError,
} from "./textGen";

const ENV_KEY = "REPLICATE_API_TOKEN";
const originalEnv = process.env[ENV_KEY];

async function cleanup(): Promise<void> {
  await db.delete(textGenSettingsTable).where(eq(textGenSettingsTable.id, 1));
}

beforeEach(async () => {
  delete process.env[ENV_KEY];
  storedKey.value = null;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe("replicate text provider", () => {
  it("key resolution: shared video-gen key wins over the env secret", async () => {
    expect(await resolveReplicateTextKey()).toBeNull();
    expect(await getReplicateTextKeySource()).toBeNull();

    process.env[ENV_KEY] = "env-key";
    expect(await resolveReplicateTextKey()).toBe("env-key");
    expect(await getReplicateTextKeySource()).toBe("env");

    storedKey.value = "db-key";
    expect(await resolveReplicateTextKey()).toBe("db-key");
    expect(await getReplicateTextKeySource()).toBe("database");
  });

  it("resolveTextModel keeps listed models and falls back to the default", () => {
    const selection = {
      provider: "replicate" as const,
      models: ["openai/gpt-oss-20b", "meta/meta-llama-3-70b-instruct"],
      defaultModel: "openai/gpt-oss-20b",
    };
    expect(resolveTextModel(selection, "meta/meta-llama-3-70b-instruct")).toBe(
      "meta/meta-llama-3-70b-instruct",
    );
    expect(resolveTextModel(selection, "gpt-5.4")).toBe("openai/gpt-oss-20b");
  });

  it("listTenantModelChoices reflects a replicate selection", async () => {
    await setTextGenSelection({
      provider: "replicate",
      models: ["openai/gpt-oss-20b"],
      defaultModel: null,
    });
    const choices = await listTenantModelChoices();
    expect(choices.provider).toBe("replicate");
    expect(choices.models).toEqual(["openai/gpt-oss-20b"]);
    expect(choices.defaultModel).toBe("openai/gpt-oss-20b");
  });

  it("getTextGenClient fails loudly when replicate is selected without a key", async () => {
    await setTextGenSelection({
      provider: "replicate",
      models: ["openai/gpt-oss-20b"],
      defaultModel: null,
    });
    await expect(getTextGenClient("openai/gpt-oss-20b")).rejects.toBeInstanceOf(
      TextGenNotConfiguredError,
    );
  });

  it("getTextGenClient returns a replicate-backed client when a key exists", async () => {
    storedKey.value = "db-key";
    await setTextGenSelection({
      provider: "replicate",
      models: ["openai/gpt-oss-20b"],
      defaultModel: null,
    });
    const textGen = await getTextGenClient("openai/gpt-oss-20b");
    expect(textGen.provider).toBe("replicate");
    expect(textGen.model).toBe("openai/gpt-oss-20b");
    expect(textGen.client.baseURL).toContain("replicate-shim.invalid");
  });
});
