import { describe, expect, it } from "vitest";
import { requiresStrictFictionalProvenance } from "./provenancePolicy";

describe("provider-scoped provenance policy", () => {
  it("requires all generated proof rows only for fictional-only reference models", () => {
    expect(requiresStrictFictionalProvenance({
      resolvedVideoModel: {
        model: "alibaba/wan-3.0-prime/reference-to-video",
      },
    } as any)).toBe(true);
    expect(requiresStrictFictionalProvenance({
      resolvedVideoModel: {
        model: "bytedance/seedance-2.5/reference-to-video",
      },
    } as any)).toBe(true);
  });

  it("keeps ordinary providers on their approved/consented legacy policy", () => {
    expect(requiresStrictFictionalProvenance({
      resolvedVideoModel: {
        model: "replicate/ordinary-video-model",
      },
    } as any)).toBe(false);
    expect(requiresStrictFictionalProvenance(null)).toBe(false);
  });
});