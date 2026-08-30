import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, imageGenSettingsTable } from "@workspace/db";
import { recordProviderFailure, resetProviderHealthForTests } from "../providerHealth";
import {
  generateImage,
  rankImageGenProviders,
  setImageGenSelection,
  getImageGenSelection,
  IMAGE_GEN_AUTO,
  IMAGE_GEN_PROVIDERS,
} from "./index";
import { ImageGenProviderError, type ImageGenResult } from "./types";

/**
 * Unit prices are injected rather than seeded, so these tests state the price
 * situation they are about instead of inheriting whatever the shared price
 * table happens to hold while other suites run against it.
 */
const { unitCosts } = vi.hoisted(() => ({ unitCosts: new Map<string, number>() }));

vi.mock("../aiCost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiCost")>()),
  imageUnitCostsPaise: vi.fn(async () => new Map(unitCosts)),
}));

vi.mock("./providers/openaiBuiltin", () => ({
  OPENAI_BUILTIN_MODEL: "gpt-image-1",
  generateWithOpenAIBuiltin: vi.fn(),
}));
vi.mock("./providers/gemini", () => ({
  GEMINI_IMAGE_MODEL: "gemini-2.5-flash-image",
  generateWithGemini: vi.fn(),
}));
vi.mock("./providers/bfl", () => ({
  BFL_MODEL: "flux-2-pro",
  generateWithBfl: vi.fn(),
}));

import { generateWithOpenAIBuiltin } from "./providers/openaiBuiltin";
import { generateWithGemini } from "./providers/gemini";
import { generateWithBfl } from "./providers/bfl";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "ARK_API_KEY",
  "BFL_API_KEY",
  "STABILITY_API_KEY",
  "REPLICATE_API_TOKEN",
  "OPENROUTER_API_KEY",
  "NVIDIA_API_KEY",
  "CUSTOM_IMAGE_API_KEY",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function result(provider: string): ImageGenResult {
  return { buffer: Buffer.from(provider), provider, model: `${provider}-model` };
}

const REFERENCE = { buffer: Buffer.from("ref"), mimeType: "image/png" };

describe("the auto sentinel", () => {
  it("collides with no provider id in the catalog", () => {
    // It shares the free-text `provider` settings column with real ids, so a
    // catalog entry called "auto" would silently become unreachable.
    expect(IMAGE_GEN_PROVIDERS.map((p) => p.id)).not.toContain(IMAGE_GEN_AUTO);
  });
});

describe("automatic image provider routing", () => {
  beforeEach(async () => {
    vi.mocked(generateWithOpenAIBuiltin).mockReset();
    vi.mocked(generateWithGemini).mockReset();
    vi.mocked(generateWithBfl).mockReset();
    resetProviderHealthForTests();
    unitCosts.clear();
    for (const key of ENV_KEYS) delete process.env[key];
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "imagegen_%"));
    await db.delete(imageGenSettingsTable);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("reports auto with no model or base URL of its own", async () => {
    await setImageGenSelection({
      provider: IMAGE_GEN_AUTO,
      model: "left-over-model",
      customBaseUrl: "https://left-over.example.com",
    });
    // A previously pinned provider's leftovers must not describe auto routing.
    expect(await getImageGenSelection()).toEqual({
      provider: IMAGE_GEN_AUTO,
      model: null,
      customBaseUrl: null,
    });
  });

  it("sends the work to the top-ranked provider and records why it won", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    vi.mocked(generateWithGemini).mockResolvedValue(result("gemini"));

    const out = await generateImage("a calm pastel skyline", "1024x1024");
    // Nothing has been tried, so the editorial quality tier decides: 0.9 to 0.85.
    expect(out.provider).toBe("gemini");
    expect(out.fallbackStep).toBe(0);
    expect(out.routingReason).toContain("gemini won on");
    expect(out.routingReason).toContain("ahead of openai");
    expect(generateWithOpenAIBuiltin).not.toHaveBeenCalled();
  });

  it("ignores an admin model override once routing is automatic", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    await setImageGenSelection({
      provider: IMAGE_GEN_AUTO,
      model: "some-pinned-model",
      customBaseUrl: null,
    });
    vi.mocked(generateWithGemini).mockResolvedValue(result("gemini"));

    await generateImage("p", "1024x1024");
    expect(vi.mocked(generateWithGemini).mock.calls[0][0].model).toBe("gemini-2.5-flash-image");
  });

  it("breaks a quality tie on price", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.BFL_API_KEY = "test-bfl-key";
    // gemini and bfl are both rated 0.9, so cost is the only axis left.
    unitCosts.set("gemini", 900);
    unitCosts.set("bfl", 100);
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    vi.mocked(generateWithBfl).mockResolvedValue(result("bfl"));

    const out = await generateImage("p", "1024x1024");
    expect(out.provider).toBe("bfl");
    expect(out.routingReason).toContain("₹1.00");
    expect(generateWithGemini).not.toHaveBeenCalled();
  });

  it("attributes a fallback to the provider that failed", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    vi.mocked(generateWithGemini).mockRejectedValue(
      new ImageGenProviderError("upstream down", 503),
    );
    vi.mocked(generateWithOpenAIBuiltin).mockResolvedValue(result("openai"));

    const out = await generateImage("p", "1024x1024");
    expect(out.provider).toBe("openai");
    expect(out.fallbackStep).toBe(1);
    expect(out.routingReason).toBe("openai served after gemini failed: upstream down");
  });

  it("leaves a provider with an open breaker for last", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:gemini", "503");
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    vi.mocked(generateWithOpenAIBuiltin).mockResolvedValue(result("openai"));

    const out = await generateImage("p", "1024x1024");
    // gemini is still the better-rated model; it is also currently broken.
    expect(out.provider).toBe("openai");
    expect(out.fallbackStep).toBe(0);
    expect(generateWithGemini).not.toHaveBeenCalled();
  });

  it("still fails permanently on a permanent error", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    vi.mocked(generateWithGemini).mockRejectedValue(
      new ImageGenProviderError("prompt rejected", 400),
    );

    await expect(generateImage("p", "1024x1024")).rejects.toThrow("prompt rejected");
    expect(generateWithOpenAIBuiltin).not.toHaveBeenCalled();
  });

  it("falls through to the built-in provider when nothing can be ranked", async () => {
    // Auto with only the keyless built-in available: it must still generate.
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    vi.mocked(generateWithOpenAIBuiltin).mockResolvedValue(result("openai"));

    const out = await generateImage("p", "1024x1024");
    expect(out.provider).toBe("openai");
    expect(out.fallbackStep).toBe(0);
  });

  it("leaves a pinned provider's happy path unexplained", async () => {
    await setImageGenSelection({ provider: "openai", model: null, customBaseUrl: null });
    vi.mocked(generateWithOpenAIBuiltin).mockResolvedValue(result("openai"));

    const out = await generateImage("p", "1024x1024");
    // There was no choice to explain, so there is no reason to store.
    expect(out.fallbackStep).toBe(0);
    expect(out.routingReason).toBeUndefined();
  });

  it("overrides an incapable pin when visual references are mandatory", async () => {
    process.env.BFL_API_KEY = "test-bfl-key";
    await setImageGenSelection({ provider: "bfl", model: null, customBaseUrl: null });
    vi.mocked(generateWithOpenAIBuiltin).mockResolvedValue(result("openai"));

    const out = await generateImage("p", "1024x1024", REFERENCE, {
      requireReferenceInput: true,
    });

    expect(out.provider).toBe("openai");
    expect(out.routingReason).toContain("cannot consume the approved reference image");
    expect(generateWithBfl).not.toHaveBeenCalled();
    expect(generateWithOpenAIBuiltin).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImage: REFERENCE }),
      null,
    );
  });
});

describe("rankImageGenProviders", () => {
  beforeEach(async () => {
    resetProviderHealthForTests();
    unitCosts.clear();
    for (const key of ENV_KEYS) delete process.env[key];
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "imagegen_%"));
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("ranks every configured provider with its evidence", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const ranked = await rankImageGenProviders();
    expect(ranked.map((r) => r.id)).toEqual(["gemini", "openai"]);
    expect(ranked.every((r) => r.reason.length > 0)).toBe(true);
    expect(ranked.every((r) => r.healthy)).toBe(true);
  });

  it("omits providers that cannot take a reference image", async () => {
    process.env.BFL_API_KEY = "test-bfl-key";
    const ranked = await rankImageGenProviders(REFERENCE);
    // bfl is text-to-image only, so it is not a candidate for this request.
    expect(ranked.map((r) => r.id)).toEqual(["openai"]);
  });

  it("omits providers with no key configured", async () => {
    const ranked = await rankImageGenProviders();
    expect(ranked.map((r) => r.id)).toEqual(["openai"]);
  });
});
