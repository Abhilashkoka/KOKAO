import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMotionInstruction,
  motionPresetClause,
  DEFAULT_MOTION_INSTRUCTION,
} from "./motionPrompt";
import { findMotionPreset } from "./motionPresets";

const kitState = vi.hoisted(() => ({
  active: null as null | { version: { contentSnapshot: any[] } },
  throws: false,
}));
vi.mock("../promptKit", () => ({
  loadActiveCasePrompt: vi.fn(async () => {
    if (kitState.throws) throw new Error("db down");
    return kitState.active;
  }),
  // Real behavior: unresolved {{placeholders}} become empty strings.
  substitutePlaceholders: vi.fn((text: string) => ({
    text: text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, ""),
    missing: [],
  })),
}));

beforeEach(() => {
  kitState.active = null;
  kitState.throws = false;
});

const block = (id: string, content: string, order: number) => ({
  id,
  title: id,
  content,
  mandatory: true,
  order,
});

describe("getMotionInstruction", () => {
  it("falls back to the built-in wording when no template governs the flow", async () => {
    expect(await getMotionInstruction()).toBe(DEFAULT_MOTION_INSTRUCTION);
  });

  it("fails open to the built-in wording when the Kit lookup throws", async () => {
    kitState.throws = true;
    expect(await getMotionInstruction()).toBe(DEFAULT_MOTION_INSTRUCTION);
  });

  it("uses the governed blocks, joined in block order", async () => {
    kitState.active = {
      version: {
        contentSnapshot: [
          block("b2", "Slow dolly-in, shallow depth of field.", 2),
          block("b1", "Gentle handheld drift.", 1),
        ],
      },
    };
    expect(await getMotionInstruction()).toBe(
      "Gentle handheld drift. Slow dolly-in, shallow depth of field.",
    );
  });

  it("falls back when the governed template compiles to an empty string", async () => {
    kitState.active = {
      version: { contentSnapshot: [block("b1", "   ", 1), block("b2", "{{unset}}", 2)] },
    };
    expect(await getMotionInstruction()).toBe(DEFAULT_MOTION_INSTRUCTION);
  });
});

describe("named motion presets", () => {
  it("uses the preset's own sentence instead of the built-in wording", async () => {
    const preset = findMotionPreset("crash-zoom-in")!;
    expect(await getMotionInstruction("crash-zoom-in")).toBe(preset.prompt);
  });

  it("beats a governed template, which would otherwise contradict it", async () => {
    // "Subtle natural motion" and "crash zoom" cannot both be obeyed. The
    // user's explicit pick wins; governance still owns the DEFAULT.
    kitState.active = {
      version: { contentSnapshot: [block("b1", "Barely any movement at all.", 1)] },
    };
    expect(await getMotionInstruction("crash-zoom-in")).toBe(
      findMotionPreset("crash-zoom-in")!.prompt,
    );
    expect(await getMotionInstruction()).toBe("Barely any movement at all.");
  });

  it("falls through to the governed default for an unknown id", async () => {
    expect(await getMotionInstruction("not-a-preset")).toBe(DEFAULT_MOTION_INSTRUCTION);
  });
});

describe("motionPresetClause", () => {
  it("is null without a preset, so a text prompt is left byte-identical", () => {
    expect(motionPresetClause(null)).toBeNull();
    expect(motionPresetClause(undefined)).toBeNull();
    expect(motionPresetClause("not-a-preset")).toBeNull();
  });

  it("returns the preset sentence when one is picked", () => {
    expect(motionPresetClause("orbit-360")).toBe(findMotionPreset("orbit-360")!.prompt);
  });
});
