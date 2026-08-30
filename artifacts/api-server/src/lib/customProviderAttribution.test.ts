import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  db,
  customAiProvidersTable,
  imageGenSettingsTable,
  videoGenSettingsTable,
  aiModelPricesTable,
  aiCostSettingsTable,
} from "@workspace/db";
import { inArray, eq } from "drizzle-orm";

// Mock ONLY the network adapters. Everything above them — dynamic custom
// defs, routing, selection, cost lookup — runs for real, which is the point:
// these tests pin that a result routed through an admin-added custom provider
// keeps its "custom:<id>" identity all the way to usage/cost attribution.
vi.mock("./imageGen/providers/openaiCompatible", () => ({
  generateWithOpenAICompatible: vi.fn(async (input: { model: string }) => ({
    buffer: Buffer.from("fake-png"),
    // The adapter reports its own generic id, exactly like the real one.
    provider: "custom",
    model: input.model,
  })),
}));
vi.mock("./videoGen/providers/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./videoGen/providers/openrouter")>();
  return {
    ...actual,
    generateWithOpenRouterVideo: vi.fn(async (input: { model: string; durationSec: number }) => ({
      buffer: Buffer.from("fake-mp4"),
      // The shared OpenRouter-shaped adapter reports its own generic id.
      provider: "openrouter",
      model: input.model,
      durationSec: input.durationSec,
    })),
  };
});

import { generateWithOpenAICompatible } from "./imageGen/providers/openaiCompatible";
import { generateWithOpenRouterVideo } from "./videoGen/providers/openrouter";
import { createCustomAiProvider, customProviderRef } from "./customAiProviders";
import {
  generateImage,
  getImageGenSelection,
  setImageGenSelection,
  IMAGE_GEN_PROVIDERS,
  isImageGenProviderConfigured,
  imageGenHealthKey,
} from "./imageGen";
import { generateVideo, getVideoGenSelection, setVideoGenSelection } from "./videoGen";
import { preflightVideoJob } from "./videoGen/preflight";
import {
  upsertModelPrice,
  computeImageCostPaise,
  computeVideoCostPaise,
  getAiCostConfig,
  setAiCostConfig,
} from "./aiCost";
import {
  recordProviderFailure,
  resetProviderHealthForTests,
} from "./providerHealth";

// Real dev DB: unique names so runs never collide; clean up what we create.
const RUN = `custom-attr-test-${Date.now()}`;
const createdProviderIds: number[] = [];
const createdPriceIds: number[] = [];

// Snapshot the shared global settings rows so this suite can point them at a
// custom provider and put them back exactly as found.
let imageSettingsSnapshot: Awaited<ReturnType<typeof getImageGenSelection>> | null = null;
let videoSettingsSnapshot: Awaited<ReturnType<typeof getVideoGenSelection>> | null = null;
let hadImageRow = false;
let hadVideoRow = false;
let originalRatePaise: number;

const ENV_KEYS = [
  "REPLICATE_API_TOKEN",
  "GEMINI_API_KEY",
  "ARK_API_KEY",
  "BFL_API_KEY",
  "STABILITY_API_KEY",
  "OPENROUTER_API_KEY",
  "CUSTOM_IMAGE_API_KEY",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  hadImageRow = (await db.select().from(imageGenSettingsTable).limit(1)).length > 0;
  hadVideoRow = (await db.select().from(videoGenSettingsTable).limit(1)).length > 0;
  imageSettingsSnapshot = await getImageGenSelection();
  videoSettingsSnapshot = await getVideoGenSelection();
  originalRatePaise = (await getAiCostConfig()).usdToInrPaise;
});

afterAll(async () => {
  if (createdProviderIds.length > 0) {
    await db
      .delete(customAiProvidersTable)
      .where(inArray(customAiProvidersTable.id, createdProviderIds));
  }
  if (createdPriceIds.length > 0) {
    await db.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, createdPriceIds));
  }
  if (hadImageRow && imageSettingsSnapshot) {
    await setImageGenSelection(imageSettingsSnapshot);
  } else {
    await db.delete(imageGenSettingsTable).where(eq(imageGenSettingsTable.id, 1));
  }
  if (hadVideoRow && videoSettingsSnapshot) {
    await setVideoGenSelection(videoSettingsSnapshot);
  } else {
    await db.delete(videoGenSettingsTable).where(eq(videoGenSettingsTable.id, 1));
  }
  await db
    .insert(aiCostSettingsTable)
    .values({ id: 1, usdToInrPaise: originalRatePaise })
    .onConflictDoUpdate({
      target: aiCostSettingsTable.id,
      set: { usdToInrPaise: originalRatePaise, updatedAt: new Date() },
    });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetProviderHealthForTests();
});

async function makeCustomProvider(opts: {
  name: string;
  imageEnabled?: boolean;
  videoEnabled?: boolean;
}) {
  const row = await createCustomAiProvider({
    name: opts.name,
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-attr-test",
    textEnabled: false,
    imageEnabled: opts.imageEnabled ?? false,
    videoEnabled: opts.videoEnabled ?? false,
  });
  createdProviderIds.push(row.id);
  return row;
}

describe("image generation through a custom provider", () => {
  it("stamps the result with custom:<id>, not the generic adapter id", async () => {
    const row = await makeCustomProvider({ name: `${RUN}-img`, imageEnabled: true });
    const ref = customProviderRef(row.id);
    await setImageGenSelection({
      provider: ref,
      model: `${RUN}-shared-model`,
      customBaseUrl: null,
    });

    const result = await generateImage("a red square", "1024x1024");

    // This is the string usage/cost rows record via buildImageCostMeta —
    // regressing it silently mis-attributes cost to the "custom" adapter id.
    expect(result.provider).toBe(ref);
    expect(result.model).toBe(`${RUN}-shared-model`);
    // The generic adapter ran underneath, against the row's base URL/key.
    expect(vi.mocked(generateWithOpenAICompatible)).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: row.baseUrl }),
      "sk-attr-test",
    );
  });
});

describe("video generation through the custom video def", () => {
  it("stamps the result with custom:<id>, not the shared openrouter adapter id", async () => {
    const row = await makeCustomProvider({ name: `${RUN}-vid`, videoEnabled: true });
    const ref = customProviderRef(row.id);
    const model = `${RUN}-t2v-model`;
    // Generation is intentionally fail-closed: even custom models must have an
    // authoritative provider+model price before the adapter can run.
    const price = await upsertModelPrice({
      kind: "video",
      provider: ref,
      model,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 0.5,
    });
    createdPriceIds.push(price.id);
    await setVideoGenSelection({
      provider: ref,
      textToVideoModel: model,
      imageToVideoModel: `${RUN}-i2v-model`,
    });

    const result = await generateVideo({
      mode: "text",
      prompt: "a spinning cube",
      aspectRatio: "9:16",
      durationSec: 5,
    });

    expect(result.provider).toBe(ref);
    expect(result.model).toBe(model);
    // The shared adapter was pointed at the custom row's base URL and key.
    expect(vi.mocked(generateWithOpenRouterVideo)).toHaveBeenCalledWith(
      expect.objectContaining({ model }),
      "sk-attr-test",
      expect.objectContaining({ baseUrl: row.baseUrl }),
    );
  });
});

describe("cost picks the custom provider's price when two providers share a model name", () => {
  const SHARED_MODEL = `${RUN}-shared-price-model`;

  it("image: exact provider match beats the model-only fallback", async () => {
    await setAiCostConfig({ usdToInrPaise: 8600 });
    const row = await makeCustomProvider({ name: `${RUN}-imgprice`, imageEnabled: true });
    const ref = customProviderRef(row.id);

    // Two price rows for the SAME model name under different providers.
    for (const [provider, usd] of [
      ["gemini", 0.04],
      [ref, 0.01],
    ] as const) {
      const price = await upsertModelPrice({
        kind: "image",
        provider,
        model: SHARED_MODEL,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
        usdPerImage: usd,
        usdPerSecond: null,
        usdPerVideo: null,
      });
      createdPriceIds.push(price.id);
    }

    // custom:<id> gets ITS price ($0.01 → 86 paise), never gemini's.
    expect(await computeImageCostPaise({ provider: ref, model: SHARED_MODEL })).toBe(86);
    expect(await computeImageCostPaise({ provider: "gemini", model: SHARED_MODEL })).toBe(344);
  });

  it("video: exact provider match beats the model-only fallback", async () => {
    const row = await makeCustomProvider({ name: `${RUN}-vidprice`, videoEnabled: true });
    const ref = customProviderRef(row.id);
    const MODEL = `${RUN}-shared-video-model`;

    for (const [provider, usd] of [
      ["replicate", 2],
      [ref, 0.5],
    ] as const) {
      const price = await upsertModelPrice({
        kind: "video",
        provider,
        model: MODEL,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
        usdPerImage: null,
        usdPerSecond: null,
        usdPerVideo: usd,
      });
      createdPriceIds.push(price.id);
    }

    expect(await computeVideoCostPaise({ provider: ref, model: MODEL })).toBe(4300); // $0.5
    expect(await computeVideoCostPaise({ provider: "replicate", model: MODEL })).toBe(17200); // $2
  });
});

describe("topic-video preflight with only a custom image provider", () => {
  /** Trip a circuit breaker the way three real consecutive failures would. */
  function open(key: string): void {
    for (let i = 0; i < 3; i++) recordProviderFailure(key);
  }

  it("counts the selected custom image provider as a healthy candidate", async () => {
    resetProviderHealthForTests();
    for (const key of ENV_KEYS) delete process.env[key];

    const row = await makeCustomProvider({ name: `${RUN}-preflight`, imageEnabled: true });
    const ref = customProviderRef(row.id);
    await setImageGenSelection({ provider: ref, model: `${RUN}-m`, customBaseUrl: null });

    // The keyless built-in provider is always "configured", and the shared
    // dev DB may hold stored admin keys for others — trip every configured
    // static provider's breaker so the custom provider is the only healthy
    // image candidate left.
    for (const def of IMAGE_GEN_PROVIDERS) {
      if (await isImageGenProviderConfigured(def)) open(imageGenHealthKey(def.id));
    }

    expect(
      await preflightVideoJob("topic_to_video", { aspectRatio: "9:16", visualsSource: "ai" }),
    ).toBeNull();

    // And when the custom provider is failing too, preflight refuses with a
    // retryable 503 — proving it really was the candidate that passed above.
    open(`imagegen:${ref}`);
    const issue = await preflightVideoJob("topic_to_video", {
      aspectRatio: "9:16",
      visualsSource: "ai",
    });
    expect(issue?.status).toBe(503);
    expect(issue?.message).toContain("image provider");
  });
});
