import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_MODEL,
  SUPPORTED_AI_MODELS,
  isSupportedAiModel,
  resolveAiModel,
} from "./aiModels";

describe("aiModels", () => {
  it("accepts every supported model unchanged", () => {
    for (const model of SUPPORTED_AI_MODELS) {
      expect(isSupportedAiModel(model)).toBe(true);
      expect(resolveAiModel(model)).toBe(model);
    }
  });

  it("falls back to the default for retired model names", () => {
    for (const legacy of ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", ""]) {
      expect(isSupportedAiModel(legacy)).toBe(false);
      expect(resolveAiModel(legacy)).toBe(DEFAULT_AI_MODEL);
    }
  });

  it("keeps the default itself in the supported list", () => {
    expect(isSupportedAiModel(DEFAULT_AI_MODEL)).toBe(true);
  });
});
