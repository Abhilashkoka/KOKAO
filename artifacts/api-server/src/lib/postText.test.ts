import { describe, it, expect } from "vitest";
import { buildPostText } from "./postText";

describe("buildPostText", () => {
  it("prefixes the title on its own line before the caption", () => {
    expect(buildPostText("My Title", "The caption body.")).toBe(
      "My Title\n\nThe caption body.",
    );
  });

  it("returns just the caption when there is no title", () => {
    expect(buildPostText("", "The caption body.")).toBe("The caption body.");
    expect(buildPostText(null, "The caption body.")).toBe("The caption body.");
  });

  it("returns just the title when there is no caption", () => {
    expect(buildPostText("My Title", "")).toBe("My Title");
    expect(buildPostText("My Title", null)).toBe("My Title");
  });

  it("does not duplicate a title the caption already starts with", () => {
    expect(buildPostText("My Title", "my title and more text")).toBe(
      "my title and more text",
    );
  });

  it("trims whitespace from both parts", () => {
    expect(buildPostText("  T  ", "  C  ")).toBe("T\n\nC");
  });
});
