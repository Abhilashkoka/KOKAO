import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { db, appCredentialsTable, imageGenSettingsTable } from "@workspace/db";
import {
  recordProviderFailure,
  resetProviderHealthForTests,
} from "../providerHealth";
import { generateImage, setImageGenSelection } from "./index";
import { ImageGenProviderError, type ImageGenResult } from "./types";

vi.mock("./providers/openaiBuiltin", () => ({
  OPENAI_BUILTIN_MODEL: "gpt-image-1",
  generateWithOpenAIBuiltin: vi.fn(),
}));
vi.mock("./providers/gemini", () => ({
  GEMINI_IMAGE_MODEL: "gemini-2.5-flash-image",
  generateWithGemini: vi.fn(),
}));
vi.mock("./providers/seedream", () => ({
  SEEDREAM_MODEL: "seedream-5-0-pro",
  generateWithSeedream: vi.fn(),
}));
vi.mock("./providers/bfl", () => ({
  BFL_MODEL: "flux-2-pro",
  generateWithBfl: vi.fn(),
}));

import { generateWithOpenAIBuiltin } from "./providers/openaiBuiltin";
import { generateWithGemini } from "./providers/gemini";
import { generateWithSeedream } from "./providers/seedream";
import { generateWithBfl } from "./providers/bfl";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "ARK_API_KEY",
  "BFL_API_KEY",
  "STABILITY_API_KEY",
  "REPLICATE_API_TOKEN",
  "OPENROUTER_API_KEY",
  "CUSTOM_IMAGE_API_KEY",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function result(provider: string): ImageGenResult {
  return { buffer: Buffer.from(provider), provider, model: `${provider}-model` };
}

describe("generateImage provider fallback", () => {
  beforeEach(async () => {
    vi.mocked(generateWithOpenAIBuiltin).mockReset();
    vi.mocked(generateWithGemini).mockReset();
    vi.mocked(generateWithSeedream).mockReset();
    vi.mocked(generateWithBfl).mockReset();
    resetProviderHealthForTests();
    for (const key of ENV_KEYS) delete process.env[key];
    // Stored admin keys would override env config; clear them for determinism.
    await db.delete(appCredentialsTable).where(like(appCredentialsTable.provider, "imagegen_%"));
    await db.delete(imageGenSettingsTable);
    await setImageGenSelection({ provider: "openai", model: null, customBaseUrl: null });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("falls back to another configured provider on a transient failure", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    vi.mocked(generateWithOpenAIBuiltin).mockRejectedValue(
      new ImageGenProviderError("upstream down", 503),
    );
    vi.mocked(generateWithGemini).mockResolvedValue(result("gemini"));

    const out = await generateImage("a calm pastel skyline", "1024x1024");
    expect(out.provider).toBe("gemini");
    expect(generateWithOpenAIBuiltin).toHaveBeenCalledTimes(1);
    expect(generateWithGemini).toHaveBeenCalledTimes(1);
    // Fallback runs with ITS default model, not the selection's override.
    expect(vi.mocked(generateWithGemini).mock.calls[0][0].model).toBe("gemini-2.5-flash-image");
  });

  it("does not fall back on a permanent error", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    vi.mocked(generateWithOpenAIBuiltin).mockRejectedValue(
      new ImageGenProviderError("prompt rejected", 400),
    );

    await expect(generateImage("p", "1024x1024")).rejects.toThrow("prompt rejected");
    expect(generateWithGemini).not.toHaveBeenCalled();
  });

  it("rethrows the primary error when no alternate is configured", async () => {
    vi.mocked(generateWithOpenAIBuiltin).mockRejectedValue(
      new ImageGenProviderError("rate limited", 429),
    );

    await expect(generateImage("p", "1024x1024")).rejects.toThrow("rate limited");
    expect(generateWithGemini).not.toHaveBeenCalled();
    expect(generateWithSeedream).not.toHaveBeenCalled();
  });

  it("prefers the healthiest alternate when a breaker is open", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.ARK_API_KEY = "test-ark-key";
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:gemini");
    vi.mocked(generateWithOpenAIBuiltin).mockRejectedValue(
      new ImageGenProviderError("upstream down", 502),
    );
    vi.mocked(generateWithSeedream).mockResolvedValue(result("seedream"));

    const out = await generateImage("p", "1024x1024");
    expect(out.provider).toBe("seedream");
    expect(generateWithGemini).not.toHaveBeenCalled();
  });

  it("skips alternates that cannot take the reference image", async () => {
    process.env.BFL_API_KEY = "test-bfl-key";
    vi.mocked(generateWithOpenAIBuiltin).mockRejectedValue(
      new ImageGenProviderError("upstream down", 503),
    );

    await expect(
      generateImage("p", "1024x1024", { buffer: Buffer.from("ref"), mimeType: "image/png" }),
    ).rejects.toThrow("upstream down");
    expect(generateWithBfl).not.toHaveBeenCalled();
  });

  it("tries the second alternate when the first also fails transiently", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.ARK_API_KEY = "test-ark-key";
    vi.mocked(generateWithOpenAIBuiltin).mockRejectedValue(
      new ImageGenProviderError("upstream down", 503),
    );
    vi.mocked(generateWithGemini).mockRejectedValue(
      new ImageGenProviderError("also down", 503),
    );
    vi.mocked(generateWithSeedream).mockResolvedValue(result("seedream"));

    const out = await generateImage("p", "1024x1024");
    expect(out.provider).toBe("seedream");
  });
});
