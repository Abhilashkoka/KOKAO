import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { db, textGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getTextGenSelection,
  setTextGenSelection,
  getStoredOpenRouterKey,
  setStoredOpenRouterKey,
  clearStoredOpenRouterKey,
  getOpenRouterKeySource,
  resolveOpenRouterKey,
  resolveTextModel,
  isAllowedTenantModel,
  listTenantModelChoices,
  getTextGenClient,
  TextGenNotConfiguredError,
} from "./textGen";
import { SUPPORTED_AI_MODELS, DEFAULT_AI_MODEL } from "./aiModels";

// Hits the real dev DB like the rest of the suite; cleans up after itself.
const ENV_KEY = "OPENROUTER_API_KEY";
const originalEnv = process.env[ENV_KEY];

async function cleanup(): Promise<void> {
  await db.delete(textGenSettingsTable).where(eq(textGenSettingsTable.id, 1));
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "textgen_openrouter"));
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

describe("text-gen selection", () => {
  it("defaults to builtin when no row exists", async () => {
    const selection = await getTextGenSelection();
    expect(selection.provider).toBe("builtin");
    expect(selection.models).toEqual([]);
    expect(selection.defaultModel).toBeNull();
  });

  it("persists and round-trips an openrouter selection", async () => {
    await setTextGenSelection({
      provider: "openrouter",
      models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
      defaultModel: "openai/gpt-4o-mini",
    });
    const selection = await getTextGenSelection();
    expect(selection.provider).toBe("openrouter");
    expect(selection.models).toEqual([
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-haiku",
    ]);
    expect(selection.defaultModel).toBe("openai/gpt-4o-mini");
  });

  it("keeps openrouter with an empty model list and fails loudly downstream", async () => {
    await setTextGenSelection({ provider: "openrouter", models: [], defaultModel: null });
    const selection = await getTextGenSelection();
    expect(selection.provider).toBe("openrouter");
    expect(() => resolveTextModel(selection, "anything")).toThrow(TextGenNotConfiguredError);
    await setStoredOpenRouterKey("sk-or-test");
    await expect(getTextGenClient("anything")).rejects.toBeInstanceOf(TextGenNotConfiguredError);
  });

  it("falls back to the first model when defaultModel is not in the list", async () => {
    await setTextGenSelection({
      provider: "openrouter",
      models: ["a/one", "b/two"],
      defaultModel: "gone/model",
    });
    const selection = await getTextGenSelection();
    expect(selection.defaultModel).toBe("a/one");
  });
});

describe("OpenRouter key storage", () => {
  it("returns null when no key is anywhere", async () => {
    expect(await getStoredOpenRouterKey()).toBeNull();
    expect(await getOpenRouterKeySource()).toBeNull();
    expect(await resolveOpenRouterKey()).toBeNull();
  });

  it("stores the key encrypted and DB wins over env", async () => {
    process.env[ENV_KEY] = "env-key";
    expect(await getOpenRouterKeySource()).toBe("env");
    expect(await resolveOpenRouterKey()).toBe("env-key");

    await setStoredOpenRouterKey("sk-or-db-key");
    const row = (
      await db
        .select()
        .from(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, "textgen_openrouter"))
    )[0];
    expect(row).toBeDefined();
    expect(row!.encryptedCredentials).not.toContain("sk-or-db-key");
    expect(await getOpenRouterKeySource()).toBe("database");
    expect(await resolveOpenRouterKey()).toBe("sk-or-db-key");

    await clearStoredOpenRouterKey();
    expect(await getOpenRouterKeySource()).toBe("env");
    expect(await resolveOpenRouterKey()).toBe("env-key");
  });
});

describe("model resolution and choices", () => {
  it("builtin: maps unknown tenant models to the default", () => {
    const selection = { provider: "builtin" as const, models: [], defaultModel: null };
    expect(resolveTextModel(selection, "not-a-model")).toBe(DEFAULT_AI_MODEL);
    expect(resolveTextModel(selection, SUPPORTED_AI_MODELS[0]!)).toBe(SUPPORTED_AI_MODELS[0]);
  });

  it("openrouter: keeps listed models, falls back to the default otherwise", () => {
    const selection = {
      provider: "openrouter" as const,
      models: ["a/one", "b/two"],
      defaultModel: "b/two",
    };
    expect(resolveTextModel(selection, "a/one")).toBe("a/one");
    expect(resolveTextModel(selection, "gpt-5.4")).toBe("b/two");
  });

  it("isAllowedTenantModel follows the active provider", async () => {
    expect(await isAllowedTenantModel(SUPPORTED_AI_MODELS[0]!)).toBe(true);
    expect(await isAllowedTenantModel("a/one")).toBe(false);

    await setTextGenSelection({
      provider: "openrouter",
      models: ["a/one"],
      defaultModel: "a/one",
    });
    expect(await isAllowedTenantModel("a/one")).toBe(true);
    expect(await isAllowedTenantModel(SUPPORTED_AI_MODELS[0]!)).toBe(false);
  });

  it("listTenantModelChoices reflects the active provider", async () => {
    const builtin = await listTenantModelChoices();
    expect(builtin.provider).toBe("builtin");
    expect(builtin.models).toEqual([...SUPPORTED_AI_MODELS]);

    await setTextGenSelection({
      provider: "openrouter",
      models: ["a/one", "b/two"],
      defaultModel: "b/two",
    });
    const or = await listTenantModelChoices();
    expect(or.provider).toBe("openrouter");
    expect(or.models).toEqual(["a/one", "b/two"]);
    expect(or.defaultModel).toBe("b/two");
  });
});

describe("getTextGenClient", () => {
  it("fails loudly when openrouter is selected without a key", async () => {
    await setTextGenSelection({
      provider: "openrouter",
      models: ["a/one"],
      defaultModel: "a/one",
    });
    await expect(getTextGenClient("a/one")).rejects.toBeInstanceOf(TextGenNotConfiguredError);
  });

  it("returns an openrouter-based client when a key exists", async () => {
    await setTextGenSelection({
      provider: "openrouter",
      models: ["a/one"],
      defaultModel: "a/one",
    });
    await setStoredOpenRouterKey("sk-or-test");
    const result = await getTextGenClient("a/one");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("a/one");
    expect(String(result.client.baseURL)).toContain("openrouter.ai");
  });

  it("uses the builtin client by default", async () => {
    const result = await getTextGenClient("gpt-5.4");
    expect(result.provider).toBe("builtin");
    expect(result.model).toBe("gpt-5.4");
  });
});
