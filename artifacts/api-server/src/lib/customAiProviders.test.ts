import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { db, customAiProvidersTable, textGenSettingsTable } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";
import {
  parseCustomProviderId,
  customProviderRef,
  createCustomAiProvider,
  updateCustomAiProvider,
  deleteCustomAiProvider,
  getCustomAiProvider,
  resolveCustomProvider,
  decryptCustomProviderKey,
  validateCustomBaseUrl,
  validateVideoApiMapping,
  customProviderView,
} from "./customAiProviders";
import { getTextGenSelection, setTextGenSelection } from "./textGen";
import { resolveImageGenProviderDef } from "./imageGen";
import { resolveVideoGenProviderDef, resolveVideoGenApiKey } from "./videoGen";

// Real dev DB: track created ids and clean them up.
const createdIds: number[] = [];

// Snapshot the shared text_gen_settings row (single global row on the shared
// dev DB) so selection tests can mutate and restore it.
let textGenSnapshot: { provider: string; models: string[]; defaultModel: string | null } | null =
  null;

beforeAll(async () => {
  const row = (await db.select().from(textGenSettingsTable).limit(1))[0];
  textGenSnapshot = row
    ? { provider: row.provider, models: row.models, defaultModel: row.defaultModel }
    : null;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(customAiProvidersTable).where(inArray(customAiProvidersTable.id, createdIds));
  }
  if (textGenSnapshot) {
    await setTextGenSelection(textGenSnapshot);
  } else {
    await db.delete(textGenSettingsTable).where(eq(textGenSettingsTable.id, 1));
  }
});

describe("custom provider refs", () => {
  it("round-trips custom:<id>", () => {
    expect(customProviderRef(7)).toBe("custom:7");
    expect(parseCustomProviderId("custom:7")).toBe(7);
  });

  it("rejects non-custom and malformed refs", () => {
    expect(parseCustomProviderId("openrouter")).toBeNull();
    expect(parseCustomProviderId("custom:")).toBeNull();
    expect(parseCustomProviderId("custom:abc")).toBeNull();
    expect(parseCustomProviderId("custom:0")).toBeNull();
    expect(parseCustomProviderId("custom:-3")).toBeNull();
    expect(parseCustomProviderId("custom:1.5")).toBeNull();
  });
});

describe("validateCustomBaseUrl", () => {
  it("accepts a public https URL and strips trailing slashes", async () => {
    await expect(validateCustomBaseUrl("https://api.together.xyz/v1/")).resolves.toBe(
      "https://api.together.xyz/v1",
    );
  });

  it("rejects http", async () => {
    await expect(validateCustomBaseUrl("http://api.example.com/v1")).rejects.toThrow(/https/);
  });

  it("rejects garbage", async () => {
    await expect(validateCustomBaseUrl("not a url")).rejects.toThrow(/valid URL/);
  });

  it("rejects private hosts (SSRF guard)", async () => {
    await expect(validateCustomBaseUrl("https://127.0.0.1/v1")).rejects.toThrow(
      /blocked or private/,
    );
    await expect(validateCustomBaseUrl("https://169.254.169.254/latest")).rejects.toThrow(
      /blocked or private/,
    );
  });
});

describe("validateVideoApiMapping", () => {
  it("normalizes omitted / openrouter-template mappings to null (the stored default)", () => {
    expect(validateVideoApiMapping(undefined)).toBeNull();
    expect(validateVideoApiMapping(null)).toBeNull();
    expect(validateVideoApiMapping({ template: "openrouter" })).toBeNull();
  });

  it("rejects unknown templates and non-objects", () => {
    expect(() => validateVideoApiMapping("x")).toThrow(/must be an object/);
    expect(() => validateVideoApiMapping({ template: "weird" })).toThrow(
      /"openrouter" or "custom"/,
    );
  });

  it("lists every missing custom field in one clear message", () => {
    try {
      validateVideoApiMapping({ template: "custom" });
      expect.unreachable();
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toMatch(/incomplete/);
      expect(msg).toMatch(/submit path is required/);
      expect(msg).toMatch(/prompt field is required/);
      expect(msg).toMatch(/video URL path is required/);
    }
  });

  it("requires job id + status paths when a poll path is set, and the {id} placeholder", () => {
    expect(() =>
      validateVideoApiMapping({
        template: "custom",
        submitPath: "/videos",
        promptField: "prompt",
        videoUrlPath: "url",
        pollPath: "/videos",
      }),
    ).toThrow(/\{id\}.*(job id path|status path)|job id path/);
  });

  it("normalizes a complete custom mapping with defaults", () => {
    const mapping = validateVideoApiMapping({
      template: "custom",
      submitPath: "/v2/generate ",
      pollPath: "/v2/jobs/{id}",
      promptField: "input.text",
      jobIdPath: "job.id",
      statusPath: "job.state",
      videoUrlPath: "job.result.urls",
      pendingValues: [" working ", ""],
      modelField: "",
    });
    expect(mapping).toMatchObject({
      template: "custom",
      submitPath: "/v2/generate",
      promptField: "input.text",
      pendingValues: ["working"],
      completedValue: "completed",
    });
    expect(mapping?.modelField).toBeUndefined();
  });

  it("synchronous mapping (no poll path) needs no job id/status paths", () => {
    const mapping = validateVideoApiMapping({
      template: "custom",
      submitPath: "/generate",
      promptField: "prompt",
      videoUrlPath: "data.0.url",
    });
    expect(mapping?.pollPath).toBeUndefined();
  });

  it("rejects malformed field paths", () => {
    expect(() =>
      validateVideoApiMapping({
        template: "custom",
        submitPath: "/generate",
        promptField: "prompt..text",
        videoUrlPath: "url",
      }),
    ).toThrow(/prompt field is not a valid field path/);
  });
});

describe("CRUD + key encryption", () => {
  it("creates, updates and deletes a provider; key is encrypted at rest", async () => {
    const row = await createCustomAiProvider({
      name: "test_custom_provider",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret-123",
      textEnabled: true,
      imageEnabled: false,
      videoEnabled: false,
    });
    createdIds.push(row.id);

    // Encrypted at rest — the raw column must not contain the key.
    expect(row.encryptedApiKey).toBeTruthy();
    expect(row.encryptedApiKey).not.toContain("sk-secret-123");
    expect(decryptCustomProviderKey(row)).toBe("sk-secret-123");

    // View never leaks the key.
    const view = customProviderView(row);
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    expect(view).toMatchObject({ id: customProviderRef(row.id), hasKey: true, textEnabled: true });

    // Update keeping the key (apiKey undefined).
    const kept = await updateCustomAiProvider(row.id, {
      name: "renamed",
      baseUrl: "https://api.example.com/v2",
      textEnabled: true,
      imageEnabled: true,
      videoEnabled: true,
    });
    expect(kept?.name).toBe("renamed");
    expect(decryptCustomProviderKey(kept!)).toBe("sk-secret-123");

    // Update clearing the key (apiKey null).
    const cleared = await updateCustomAiProvider(row.id, {
      name: "renamed",
      baseUrl: "https://api.example.com/v2",
      apiKey: null,
      textEnabled: true,
      imageEnabled: true,
      videoEnabled: true,
    });
    expect(cleared?.encryptedApiKey).toBeNull();
    expect(decryptCustomProviderKey(cleared!)).toBeNull();

    expect(await deleteCustomAiProvider(row.id)).toBe(true);
    expect(await getCustomAiProvider(row.id)).toBeNull();
  });
});

describe("use-case routing integration", () => {
  it("text selection fails soft to builtin when the custom provider is gone or text-disabled", async () => {
    const row = await createCustomAiProvider({
      name: "test_textgen_custom",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      textEnabled: true,
      imageEnabled: false,
      videoEnabled: false,
    });
    createdIds.push(row.id);
    const ref = customProviderRef(row.id);

    await setTextGenSelection({ provider: ref, models: ["some-model"], defaultModel: "some-model" });
    expect((await getTextGenSelection()).provider).toBe(ref);

    // Disable text use → selection reads as builtin.
    await updateCustomAiProvider(row.id, {
      name: row.name,
      baseUrl: row.baseUrl,
      textEnabled: false,
      imageEnabled: false,
      videoEnabled: false,
    });
    expect((await getTextGenSelection()).provider).toBe("builtin");
  });

  it("image/video defs resolve only when the matching use case is enabled", async () => {
    const row = await createCustomAiProvider({
      name: "test_media_custom",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-media",
      textEnabled: false,
      imageEnabled: true,
      videoEnabled: false,
    });
    createdIds.push(row.id);
    const ref = customProviderRef(row.id);

    const imageDef = await resolveImageGenProviderDef(ref);
    expect(imageDef?.id).toBe(ref);
    expect(imageDef?.supportsModelOverride).toBe(true);
    // Custom providers are never auto-routing candidates or transparency-capable.
    expect(imageDef?.supportsTransparency).toBe(false);

    // Video not enabled → no def.
    expect(await resolveVideoGenProviderDef(ref)).toBeUndefined();

    await updateCustomAiProvider(row.id, {
      name: row.name,
      baseUrl: row.baseUrl,
      textEnabled: false,
      imageEnabled: false,
      videoEnabled: true,
    });
    expect(await resolveImageGenProviderDef(ref)).toBeUndefined();
    const videoDef = await resolveVideoGenProviderDef(ref);
    expect(videoDef?.id).toBe(ref);
    // Row key drives the video generator (placeholder when keyless).
    expect(await resolveVideoGenApiKey(videoDef!)).toBe("sk-media");
  });

  it("unknown custom refs resolve to nothing", async () => {
    expect(await resolveImageGenProviderDef("custom:999999")).toBeUndefined();
    expect(await resolveVideoGenProviderDef("custom:999999")).toBeUndefined();
    expect(await resolveCustomProvider("custom:999999")).toBeNull();
  });
});
