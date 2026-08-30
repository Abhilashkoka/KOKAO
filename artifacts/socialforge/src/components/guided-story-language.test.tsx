import { describe, expect, it } from "vitest";
import type { GuidedStoryScript } from "@workspace/api-client-react";
import {
  guidedStoryElevenLabsCapabilityWarning,
  guidedStoryWritingSystemWarning,
} from "./guided-story-workflow";

function scriptWith(text: string): GuidedStoryScript {
  return {
    version: 1,
    title: "Story",
    logline: "",
    runtimeSeconds: 1,
    warnings: [],
    roles: [{ id: "role-1", name: "Role", description: "Role" }],
    scenes: [{
      id: "scene-1",
      startMs: 0,
      endMs: 1000,
      visualDirection: "A room",
      roleIds: ["role-1"],
      lines: [{
        id: "line-1",
        ownerRoleId: "role-1",
        kind: "dialogue",
        text,
        startMs: 0,
        endMs: 1000,
      }],
    }],
  };
}

describe("Guided Story approval writing-system warning", () => {
  it("leaves exact native-script text unflagged", () => {
    expect(guidedStoryWritingSystemWarning(scriptWith("ఇది తెలుగు కథ"), "te-IN"))
      .toBeNull();
  });

  it("gives an actionable warning for Romanized spoken text", () => {
    expect(guidedStoryWritingSystemWarning(scriptWith("Idi oka Telugu katha"), "te"))
      .toBe("Telugu spoken lines appear to be Romanized. Edit them to use Telugu characters, or regenerate the script, before approval.");
  });

  it("blocks Telugu only when the configured ElevenLabs model is incompatible", () => {
    expect(guidedStoryElevenLabsCapabilityWarning("te", "eleven_multilingual_v2"))
      .toMatch(/Telugu narration requires.*v3/u);
    expect(guidedStoryElevenLabsCapabilityWarning("te", "eleven_v3")).toBeNull();
  });
});