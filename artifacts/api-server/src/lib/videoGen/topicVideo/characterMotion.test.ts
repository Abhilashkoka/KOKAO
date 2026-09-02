import { describe, it, expect } from "vitest";
import {
  characterScenePrompt,
  SPEAKING_HOLD,
  EXPRESSION_GUARD,
} from "./characterMotion";

const VISUAL = "Dr Asha stands in a busy hospital corridor, alarmed by a shocking statistic";
const MOTION = "Subtle natural motion, cinematic.";

describe("characterScenePrompt", () => {
  it("stops sending scene prose to a shot that will be lip-synced", () => {
    // The keyframe already IS this description. Sending it again asks the
    // video model to perform the beat a second time, and the emotional words
    // in it are what it performs — this prompt is where "alarmed by a shocking
    // statistic" turned into five seconds of a terrified face.
    const prompt = characterScenePrompt({ visual: VISUAL, motion: MOTION, lipSynced: true });

    expect(prompt).not.toContain("alarmed");
    expect(prompt).not.toContain("shocking");
    expect(prompt).not.toContain(VISUAL);
  });

  it("names the drift it has to prevent, not just the state it wants", () => {
    // "Calm expression" alone loses: the model starts calm and escalates
    // anyway, because nothing forbids the escalation. The negatives and the
    // across-the-shot constraint are the load-bearing half.
    const prompt = characterScenePrompt({ visual: VISUAL, motion: MOTION, lipSynced: true });

    expect(prompt).toMatch(/do not widen the eyes/i);
    expect(prompt).toMatch(/do not raise the eyebrows/i);
    expect(prompt).toMatch(/must not build or intensify/i);
    expect(prompt).toMatch(/surprise, shock, alarm/i);
  });

  it("keeps the scene prose when nothing will be synced", () => {
    // An unsynced character shot may be an action rather than a piece to
    // camera, so the visual still earns its place; only the drift is named.
    const prompt = characterScenePrompt({ visual: VISUAL, motion: MOTION, lipSynced: false });

    expect(prompt).toContain(VISUAL);
    expect(prompt).toContain(EXPRESSION_GUARD);
  });

  it("never drops the motion instruction, synced or not", () => {
    // A picked motion preset arrives here as `motion` and owns the camera.
    // These clauses only ever speak about the face; losing the preset would
    // silently discard a choice the user made.
    for (const lipSynced of [true, false]) {
      expect(characterScenePrompt({ visual: VISUAL, motion: MOTION, lipSynced })).toContain(MOTION);
    }
    const preset = "Crash zoom in, fast and aggressive.";
    expect(characterScenePrompt({ visual: VISUAL, motion: preset, lipSynced: true }))
      .toContain(preset);
  });

  it("says nothing about the camera, so it cannot contradict a preset", () => {
    // The one thing these clauses must not do is fight the motion instruction.
    for (const clause of [SPEAKING_HOLD, EXPRESSION_GUARD]) {
      expect(clause).not.toMatch(/\b(zoom|pan|dolly|push in|static camera|camera still)\b/i);
    }
  });

  it("asks for movement, so the shot is not a still", () => {
    // Overcorrecting into a frozen face is the other way to fail this.
    expect(SPEAKING_HOLD).toMatch(/head movement/i);
    expect(SPEAKING_HOLD).toMatch(/blinking/i);
  });

  it("holds one subject without naming a second person", () => {
    expect(SPEAKING_HOLD).toMatch(
      /same single subject from the first frame to the last/i,
    );
    expect(SPEAKING_HOLD).toMatch(/nothing new enters it/i);
    expect(SPEAKING_HOLD).not.toMatch(
      /second person|other person|no one else/i,
    );
  });
});