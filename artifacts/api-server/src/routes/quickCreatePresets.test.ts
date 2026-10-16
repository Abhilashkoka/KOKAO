import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, quickCreatePresetsTable: {} }));
vi.mock("../lib/adminAudit", () => ({ recordAdminAction: vi.fn() }));
vi.mock("../middlewares/requireSuperadmin", () => ({
  requireSuperadmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { normalizeQuickCreatePresetInput } = await import("./quickCreatePresets");

describe("normalizeQuickCreatePresetInput", () => {
  const base = {
    label: " Saree Showcase ",
    vertical: "fashion" as const,
    prompt: "  A model sways gently ",
    durationSec: 10,
    aspect: "9:16" as const,
  };

  it("trims text, nulls blanks and defaults to unpublished", () => {
    const result = normalizeQuickCreatePresetInput({ ...base, photoHint: "  ", musicPrompt: " sitar " });
    expect(result).toEqual({
      value: {
        label: "Saree Showcase",
        vertical: "fashion",
        prompt: "A model sways gently",
        durationSec: 10,
        aspect: "9:16",
        photoHint: null,
        musicPrompt: "sitar",
        published: false,
        sortOrder: 0,
      },
    });
  });

  it("rejects an empty name or prompt", () => {
    expect(normalizeQuickCreatePresetInput({ ...base, label: "  " })).toEqual({
      error: "Give the starter a name.",
    });
    expect(normalizeQuickCreatePresetInput({ ...base, prompt: "" })).toEqual({
      error: "Give the starter a prompt.",
    });
  });
});
