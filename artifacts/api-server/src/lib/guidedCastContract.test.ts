import { describe, expect, it } from "vitest";
import { CastGuidedStoryDraftBody } from "@workspace/api-zod";

function automaticCastRequest(count: number) {
  return {
    revision: 4,
    strategy: "generated",
    duplicateAssignmentConfirmed: true,
    assignments: Array.from({ length: count }, (_, index) => ({
      roleId: `role-${index}`,
      source: "generated",
      characterId: null,
      outfitId: null,
      consentGranted: false,
      isUserRole: false,
      voiceId: "alloy",
    })),
  };
}

describe("Guided Story automatic cast request contract", () => {
  it.each([1, 2, 4, 5, 20])("accepts a story-decided cast of %i roles", count => {
    expect(CastGuidedStoryDraftBody.safeParse(automaticCastRequest(count)).success).toBe(true);
  });

  it.each([0, 21])("rejects a malformed cast of %i roles", count => {
    expect(CastGuidedStoryDraftBody.safeParse(automaticCastRequest(count)).success).toBe(false);
  });
});