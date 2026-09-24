import { describe, expect, it } from "vitest";
import { gptImage2TokenCostUsd } from "./gptImage2Pricing";

const rates = { imageInputUsdPerMtok: 4, outputUsdPerMtok: 15 };
describe("GPT Image 2 modality pricing", () => {
  it("prices text and image input independently at official standard rates", () => {
    expect(gptImage2TokenCostUsd({
      ...rates, inputTokens: 3000, outputTokens: 1000,
      inputTokenDetails: { text_tokens: 1000, image_tokens: 2000 },
    })).toBeCloseTo(0.0255);
  });
  it("prices text-only generation without the image-input premium", () => {
    expect(gptImage2TokenCostUsd({
      ...rates, inputTokens: 1000, outputTokens: 1000,
      inputTokenDetails: { text_tokens: 1000, image_tokens: 0 },
    })).toBeCloseTo(0.0175);
  });
  it("leaves incomplete or inconsistent historical receipts unknown", () => {
    expect(gptImage2TokenCostUsd({ ...rates, inputTokens: 3000, outputTokens: 1000 })).toBeNull();
    expect(gptImage2TokenCostUsd({
      ...rates, inputTokens: 3000, outputTokens: 1000,
      inputTokenDetails: { text_tokens: 1000, image_tokens: 0 },
    })).toBeNull();
  });
});