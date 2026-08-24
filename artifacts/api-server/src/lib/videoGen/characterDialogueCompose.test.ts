import { describe, expect, it } from "vitest";
import { resolveExactFont } from "./characterDialogueCompose";

describe("resolveExactFont", () => {
  it.each([
    ["Noto Sans Telugu", "NotoSansTelugu.ttf"],
    ["Noto Sans Tamil", "NotoSansTamil.ttf"],
    ["Noto Sans Devanagari", "NotoSansDevanagari.ttf"],
  ])("resolves the bundled %s face without host font installation", async (family, filename) => {
    const font = await resolveExactFont([family]);

    expect(font.family).toBe(family);
    expect(font.file.endsWith(`/assets/fonts/${filename}`)).toBe(true);
  });
});