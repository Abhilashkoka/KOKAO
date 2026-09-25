import { describe, expect, it } from "vitest";
import { formatVideoLibraryCopy, videoLibraryCopyPrompt, VIDEO_COPY_LIMITS } from "./videoLibraryCopy";

describe("video Library copy", () => {
  it("labels briefs honestly and includes the target platform's full caption budget", () => {
    expect(videoLibraryCopyPrompt({ sourceType: "brief", text: "my original brief" }, "threads"))
      .toContain("NOT a video transcript");
    expect(videoLibraryCopyPrompt({ sourceType: "narration", text: "real narration" }, "instagram"))
      .toContain(`within ${VIDEO_COPY_LIMITS.instagram} characters`);
    expect(videoLibraryCopyPrompt({ sourceType: "narration", text: "real narration" }, "instagram"))
      .toContain("at most 5 relevant hashtags TOTAL");
    expect(videoLibraryCopyPrompt({ sourceType: "narration", text: "real narration" }, "twitter"))
      .toContain("at most 3 relevant hashtags TOTAL");
  });

  it("joins only valid unique hashtags and checks the whole platform caption", () => {
    expect(formatVideoLibraryCopy({
      title: "My new title", caption: "A new launch #KOKAO",
      hashtags: ["KOKAO", "#Reels", "reels"],
    }, "instagram")).toEqual({ title: "My new title", caption: "A new launch #KOKAO\n\n#Reels" });
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "A new launch", hashtags: ["bad tag"],
    }, "instagram")).toThrow(/invalid hashtag/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "x".repeat(277), hashtags: ["launch"],
    }, "twitter")).toThrow(/including hashtags/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "x".repeat(497), hashtags: ["launch"],
    }, "threads")).toThrow(/including hashtags/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "x".repeat(2997), hashtags: ["launch"],
    }, "linkedin")).toThrow(/including hashtags/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "x".repeat(2197), hashtags: ["launch"],
    }, "instagram")).toThrow(/including hashtags/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "#One #Two #Three", hashtags: ["Four", "Five", "Six", "one"],
    }, "instagram")).toThrow(/6 hashtags/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "#One #Two #Three", hashtags: ["Four"],
    }, "twitter")).toThrow(/4 hashtags/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "#Same #same", hashtags: [],
    }, "instagram")).toThrow(/repeats an inline hashtag/);
    expect(() => formatVideoLibraryCopy({
      title: "An update", caption: "A short update", hashtags: [],
    }, "threads")).toThrow(/at least one hashtag/);
  });

  it("requires a generated title and rejects thin-brief clarification", () => {
    expect(() => formatVideoLibraryCopy({ caption: "Text", hashtags: [] }, "instagram")).toThrow(/title/);
    expect(() => formatVideoLibraryCopy({
      title: "", caption: "", hashtags: [], clarifyingQuestions: ["What does it show?"],
    }, "instagram")).toThrow(/What does it show/);
  });
});