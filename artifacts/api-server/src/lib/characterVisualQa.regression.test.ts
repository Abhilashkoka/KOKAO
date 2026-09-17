import { describe, expect, it } from "vitest";
import {
  CharacterVisualQaError,
  describeCharacterVisualQaFailure,
} from "./characterVisualQa";
import { ImageGenOutputValidationError } from "./imageGen/types";

const providerResult = {
  buffer: Buffer.from("generated"),
  provider: "openai",
  model: "gpt-image-1",
};

describe("visual QA failure mapping", () => {
  it("keeps direct invalid sheet checks actionable and bounded", () => {
    const error = new CharacterVisualQaError(
      "provider response contains secret material",
      "invalid",
      undefined,
      "sheet",
      {
        decision: "reject",
        panelCount: 4,
        allPanelsSingleSubject: true,
        sameIdentity: false,
        designConsistent: false,
      },
    );

    const failure = describeCharacterVisualQaFailure(error, "sheet");
    expect(failure).toEqual({
      category: "invalid",
      reason:
        "Reference sheet visual QA (invalid): panel count was 4, expected 5; all panels must show the same identity; the design must match the approved primary. No reference sheet was saved.",
    });
    expect(failure?.reason).not.toContain("secret");
  });

  it("preserves the QA reason through the output-validation wrapper", () => {
    const qaError = new CharacterVisualQaError(
      "raw provider body must not escape",
      "invalid",
      undefined,
      "sheet",
      {
        decision: "reject",
        panelCount: 5,
        allPanelsSingleSubject: false,
        sameIdentity: true,
        designConsistent: true,
      },
    );
    const wrapped = new ImageGenOutputValidationError(
      "raw provider body must not escape",
      providerResult,
      qaError,
    );

    const failure = describeCharacterVisualQaFailure(wrapped, "sheet");
    expect(failure?.category).toBe("invalid");
    expect(failure?.reason).toContain("each panel must contain one subject");
    expect(failure?.reason).not.toContain("raw provider body");
    expect(wrapped.confirmedValidationError).toBe(true);
  });

  it.each([
    ["timeout", "unavailable"],
    ["malformed", "unavailable"],
    ["uncertain", "uncertain"],
  ] as const)("maps direct %s QA failures to the durable category %s", (kind, category) => {
    const error = new CharacterVisualQaError("unsafe raw response", kind);
    expect(describeCharacterVisualQaFailure(error, "sheet")?.category).toBe(category);
  });

  it.each([
    ["timeout", "unavailable"],
    ["malformed", "unavailable"],
    ["uncertain", "uncertain"],
  ] as const)("maps wrapped %s QA failures to the durable category %s", (kind, category) => {
    const qaError = new CharacterVisualQaError("unsafe raw response", kind, undefined, "sheet");
    const wrapped = new ImageGenOutputValidationError(
      "unsafe raw provider error",
      providerResult,
      qaError,
    );
    expect(describeCharacterVisualQaFailure(wrapped, "sheet")?.category).toBe(category);
  });

  it("uses sheet wording rather than portrait wording", () => {
    const error = new CharacterVisualQaError("rejected", "invalid");
    const sheet = describeCharacterVisualQaFailure(error, "sheet")?.reason;
    const portrait = describeCharacterVisualQaFailure(error, "primary")?.reason;

    expect(sheet).toContain("Reference sheet");
    expect(sheet).toContain("panel count");
    expect(sheet).not.toContain("portrait");
    expect(portrait).toContain("Generated portrait");
    expect(portrait).not.toContain("reference sheet");
  });
});