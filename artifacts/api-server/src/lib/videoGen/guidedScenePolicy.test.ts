import { describe, expect, it } from "vitest";
import type { VideoJobOptions } from "@workspace/db";
import { guidedSceneDurations, guidedUsesSavedVoice, guidedSavedVoiceSceneError } from "./guidedScenePolicy";

function story(cloned = false): NonNullable<VideoJobOptions["guidedStory"]> {
  return {
    cast: [{ roleId: "doctor", brandKitId: cloned ? 4 : null, voice: { providerVoiceId: cloned ? "voice-a" : null } }],
    script: { scenes: [
      { id: "first", startMs: 0, endMs: 30000, roleIds: ["doctor"], lines: [{ kind: "dialogue", ownerRoleId: "doctor" }] },
      { id: "last", startMs: 30000, endMs: 58000, roleIds: ["doctor"], lines: [{ kind: "dialogue", ownerRoleId: "doctor" }] },
    ] },
  } as NonNullable<VideoJobOptions["guidedStory"]>;
}

describe("Guided long-scene policy", () => {
  it("funds a 58-second story as 30 and 28-second performances", () => {
    expect(guidedSceneDurations(story())).toEqual([30, 28]);
  });
  it("rounds up without truncating fractional scene timings", () => {
    const input = story();
    input.script.scenes[1]!.endMs = 58100;
    expect(guidedSceneDurations(input)).toEqual([30, 29]);
  });
  it("rejects overlong scenes rather than silently shortening dialogue", () => {
    const input = story();
    input.script.scenes[0]!.endMs = 31000;
    expect(() => guidedSceneDurations(input)).toThrow("30 seconds");
  });
  it("defaults to native voices, but respects an owned-line clone mapping", () => {
    expect(guidedUsesSavedVoice(story())).toBe(false);
    expect(guidedUsesSavedVoice(story(true))).toBe(true);
    const input = story(true);
    input.cast[0]!.roleId = "unused";
    expect(guidedUsesSavedVoice(input)).toBe(false);
  });
  it("allows solo cloned dialogue and blocks unsafe shared-face lip-sync", () => {
    const input = story(true);
    expect(guidedSavedVoiceSceneError(input)).toBeNull();
    input.script.scenes[0]!.roleIds.push("patient");
    expect(guidedSavedVoiceSceneError(input)).toContain("solo dialogue");
    expect(guidedSavedVoiceSceneError(story())).toBeNull();
  });
});
