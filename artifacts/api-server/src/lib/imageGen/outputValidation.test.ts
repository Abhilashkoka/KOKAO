import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageGenResult } from "./types";

/**
 * This suite intentionally never reaches the real database. The image router
 * receives a durable selection policy, while every database method is a guard
 * that throws if a future change accidentally makes this boundary test write
 * settings, credentials, or customer records.
 */
const dbGuard = vi.hoisted(() => ({
  select: vi.fn(() => {
    throw new Error("output-validation test attempted a database read");
  }),
  insert: vi.fn(() => {
    throw new Error("output-validation test attempted a database write");
  }),
  update: vi.fn(() => {
    throw new Error("output-validation test attempted a database write");
  }),
  delete: vi.fn(() => {
    throw new Error("output-validation test attempted a database write");
  }),
}));
vi.mock("@workspace/db", () => ({
  db: dbGuard,
  appCredentialsTable: {},
  imageGenSettingsTable: {},
}));

const meterEvents = vi.hoisted(() => [] as Array<{
  outcome: "success" | "failed";
  reported?: unknown;
  confirmed?: boolean;
}>);
const meterMock = vi.hoisted(() =>
  vi.fn(
    async (
      _ctx: unknown,
      _key: unknown,
      _quantity: unknown,
      run: () => Promise<ImageGenResult>,
      reportedFrom?: (result: ImageGenResult) => unknown,
      options?: {
        isFailureConfirmed?: (error: unknown) => boolean;
        reportedFromError?: (error: unknown) => unknown;
      },
    ) => {
      try {
        const output = await run();
        meterEvents.push({
          outcome: "success",
          reported: await reportedFrom?.(output),
        });
        return output;
      } catch (error) {
        meterEvents.push({
          outcome: "failed",
          reported: await options?.reportedFromError?.(error),
          confirmed: options?.isFailureConfirmed?.(error),
        });
        throw error;
      }
    },
  ),
);

function isDefinitiveProviderRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown } | null;
  };
  const status = [value.status, value.statusCode, value.response?.status].find(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isInteger(candidate),
  );
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409
  );
}

vi.mock("../meter", () => ({
  meter: meterMock,
  isDefinitiveProviderRejection,
}));
vi.mock("../meterErrors", () => ({
  isMeterDispatchReplayError: () => false,
}));
vi.mock("../aiFallbackSettings", () => ({
  getAiFallbackOrders: async () => ({ image: undefined }),
  applyManualOrder: <T,>(items: readonly T[]) => [...items],
}));
vi.mock("../featureFlags", () => ({
  isFeatureEnabled: async () => true,
}));
vi.mock("../aiCost", () => ({
  imageUnitCostsPaise: async () => new Map(),
  isImageModelPriced: async () => true,
}));
vi.mock("../providerHealth", () => ({
  recordProviderFailure: vi.fn(),
  recordProviderSuccess: vi.fn(),
  orderByHealth: <T,>(items: readonly T[]) => [...items],
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../secretCrypto", () => ({
  encryptJson: vi.fn(),
  decryptJson: vi.fn(),
}));
vi.mock("../nvidiaCore", () => ({
  clearNvidiaHostedApiKey: vi.fn(),
  getNvidiaCoreConfigView: vi.fn(),
  isNvidiaCoreDeploymentActivatable: vi.fn(),
  resolveNvidiaCoreDeployment: vi.fn(),
  resolveNvidiaHostedApiKey: vi.fn(),
  setNvidiaHostedApiKey: vi.fn(),
}));
vi.mock("../customAiProviders", () => ({
  parseCustomProviderId: vi.fn(),
  resolveCustomProvider: vi.fn(),
  decryptCustomProviderKey: vi.fn(),
  customProviderRef: vi.fn(),
}));

const providers = vi.hoisted(() => ({
  openai: vi.fn(),
  gemini: vi.fn(),
  seedream: vi.fn(),
  bfl: vi.fn(),
  stability: vi.fn(),
  replicate: vi.fn(),
  openaiCompatible: vi.fn(),
  openRouter: vi.fn(),
  nvidia: vi.fn(),
  higgsfield: vi.fn(),
}));
vi.mock("./providers/openaiBuiltin", () => ({
  OPENAI_BUILTIN_MODEL: "gpt-image-1",
  generateWithOpenAIBuiltin: providers.openai,
}));
vi.mock("./providers/gemini", () => ({
  GEMINI_IMAGE_MODEL: "gemini-2.5-flash-image",
  generateWithGemini: providers.gemini,
}));
vi.mock("./providers/seedream", () => ({
  SEEDREAM_MODEL: "seedream-5-0-pro",
  generateWithSeedream: providers.seedream,
}));
vi.mock("./providers/bfl", () => ({
  BFL_MODEL: "flux-2-pro",
  generateWithBfl: providers.bfl,
}));
vi.mock("./providers/stability", () => ({
  STABILITY_MODEL: "stable-image-ultra",
  generateWithStability: providers.stability,
}));
vi.mock("./providers/replicate", () => ({
  REPLICATE_MODEL: "black-forest-labs/flux-1.1-pro",
  generateWithReplicate: providers.replicate,
}));
vi.mock("./providers/openaiCompatible", () => ({
  generateWithOpenAICompatible: providers.openaiCompatible,
}));
vi.mock("./providers/openrouter", () => ({
  OPENROUTER_IMAGE_MODEL: "google/gemini-2.5-flash-image",
  generateWithOpenRouter: providers.openRouter,
}));
vi.mock("./providers/nvidia", () => ({
  NVIDIA_SDXL_MODEL: "stabilityai/sdxl",
  generateWithNvidia: providers.nvidia,
}));
vi.mock("./providers/higgsfield", () => ({
  HIGGSFIELD_IMAGE_MODEL: "higgsfield-image",
  generateWithHiggsfield: providers.higgsfield,
}));

const { generateImage } = await import("./index");
const { ImageGenProviderError } = await import("./types");
const { validateCharacterImageOutput } = await import("../characterVisualQa");

const SELECTION = {
  provider: "openai" as const,
  model: null,
  customBaseUrl: null,
  fallbackEnabled: true,
};

function result(provider = "openai"): ImageGenResult {
  return {
    buffer: Buffer.from(provider),
    provider,
    model: "gpt-image-1",
  };
}

const meterContext = {
  tenantId: 42,
  refKind: "character",
  refId: "7",
  operationKey: "character:7:portrait",
};

describe("image output validation provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meterEvents.length = 0;
  });

  it.each(["length", "content_filter", "stop"])(
    "never regenerates or persists after real QA rejects a %s response",
    async (finishReason) => {
      providers.openai.mockResolvedValue(result());
      const onProviderSuccess = vi.fn();
      const create = vi.fn().mockResolvedValue({
        choices: [{
          finish_reason: finishReason,
          message: { content: finishReason === "stop" ? "" : JSON.stringify({
            decision: "accept", panelCount: 5, allPanelsSingleSubject: true,
            sameIdentity: true, designConsistent: true,
          }) },
        }],
      });
      await expect(generateImage("sheet", "1024x1024", undefined, {
        selectionPolicy: SELECTION,
        meterContext,
        outputValidator: (image) => validateCharacterImageOutput(
          { buffer: image.buffer, mimeType: "image/png" },
          { mode: "sheet", approvedPrimary: { buffer: Buffer.from("primary"), mimeType: "image/png" } },
          { chat: { completions: { create } } },
        ),
        onProviderSuccess,
      })).rejects.toMatchObject({
        name: "ImageGenOutputValidationError", confirmedValidationError: true,
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(providers.openai).toHaveBeenCalledTimes(1);
      for (const [name, provider] of Object.entries(providers)) {
        if (name !== "openai") expect(provider).not.toHaveBeenCalled();
      }
      expect(onProviderSuccess).not.toHaveBeenCalled();
      expect(meterEvents).toEqual([{ outcome: "failed", reported: { tokens: null }, confirmed: true }]);
      expect(dbGuard.insert).not.toHaveBeenCalled();
      expect(dbGuard.update).not.toHaveBeenCalled();
    },
  );

  it("terminates a rejected QA result, retains provider usage, and skips fallback/success", async () => {
    const providerOutput = {
      ...result(),
      usage: { inputTokens: 13, outputTokens: 29 },
    };
    providers.openai.mockResolvedValue(providerOutput);
    const onProviderSuccess = vi.fn(async () => {});

    await expect(
      generateImage("portrait", "1024x1024", undefined, {
        selectionPolicy: SELECTION,
        meterContext,
        outputValidator: async () => {
          throw new Error("QA rejected image");
        },
        onProviderSuccess,
      }),
    ).rejects.toMatchObject({
      name: "ImageGenOutputValidationError",
      message: "QA rejected image",
      providerResult: providerOutput,
    });

    expect(providers.openai).toHaveBeenCalledTimes(1);
    expect(providers.gemini).not.toHaveBeenCalled();
    expect(onProviderSuccess).not.toHaveBeenCalled();
    expect(meterEvents).toEqual([
      {
        outcome: "failed",
        reported: { tokens: 29 },
        confirmed: true,
      },
    ]);
    expect(dbGuard.select).not.toHaveBeenCalled();
    expect(dbGuard.insert).not.toHaveBeenCalled();
    expect(dbGuard.update).not.toHaveBeenCalled();
    expect(dbGuard.delete).not.toHaveBeenCalled();
  });

  it("classifies a definitive provider 4xx as confirmed without fallback or success", async () => {
    providers.openai.mockRejectedValue(new ImageGenProviderError("prompt rejected", 400));
    const onProviderSuccess = vi.fn(async () => {});

    await expect(
      generateImage("portrait", "1024x1024", undefined, {
        selectionPolicy: SELECTION,
        meterContext,
        onProviderSuccess,
      }),
    ).rejects.toMatchObject({
      name: "ImageGenProviderError",
      message: "prompt rejected",
    });

    expect(providers.openai).toHaveBeenCalledTimes(1);
    expect(providers.gemini).not.toHaveBeenCalled();
    expect(onProviderSuccess).not.toHaveBeenCalled();
    expect(meterEvents).toEqual([
      {
        outcome: "failed",
        reported: null,
        confirmed: true,
      },
    ]);
    expect(dbGuard.select).not.toHaveBeenCalled();
    expect(dbGuard.insert).not.toHaveBeenCalled();
    expect(dbGuard.update).not.toHaveBeenCalled();
    expect(dbGuard.delete).not.toHaveBeenCalled();
  });
});