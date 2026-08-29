import { describe, expect, it, vi } from "vitest";

const presets = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./presetCharacters", () => ({ getPresetForTenant: presets.resolve }));
import { validateStoryCastAssignments } from "./storyCast";

const resolved = (stableId: string) => ({
  preset: {
    stableId,
    supportedLanguages: ["en"],
    voices: [{ id: "voice", languages: ["en"] }],
  },
  outfit: {},
});

describe("validateStoryCastAssignments", () => {
  it("rejects duplicate roles and people without explicit confirmation", async () => {
    presets.resolve.mockResolvedValue(resolved("amara-sen"));
    await expect(
      validateStoryCastAssignments(
        1,
        [
          { role: "Host", presetCharacterId: "amara-sen" },
          { role: "Guest", presetCharacterId: "amara-sen" },
        ],
        false,
      ),
    ).resolves.toMatchObject({ error: expect.stringContaining("explicitly confirmed") });
  });
  it("accepts a confirmed duplicate only with a compatible licensed voice", async () => {
    presets.resolve.mockResolvedValue(resolved("amara-sen"));
    await expect(
      validateStoryCastAssignments(
        1,
        [
          { role: "Host", presetCharacterId: "amara-sen", presetVoiceId: "voice" },
          { role: "Guest", presetCharacterId: "amara-sen", presetVoiceId: "voice" },
        ],
        true,
      ),
    ).resolves.toMatchObject({ assignments: [{ language: "en" }, { language: "en" }] });
  });
});