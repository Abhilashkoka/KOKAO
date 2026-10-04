import { describe, it, expect } from "vitest";
import {
  canSubmitVideoDestination,
  defaultVideoMetadata,
  isSupportedVideoDestination,
  normalizeForDestination,
  validateVideoMetadata,
  VIDEO_DESTINATION_SPECS,
} from "./videoPublish";
import { formatVideoLibraryCopy } from "./videoLibraryCopy";

const chosen = { audienceChosen: true, privacyChosen: true };

describe("video publish rules", () => {
  it("blocks unsupported video destinations", () => {
    expect(isSupportedVideoDestination("twitter")).toBe(false);
    expect(isSupportedVideoDestination("linkedin")).toBe(false);
    expect(isSupportedVideoDestination(undefined)).toBe(false);
    expect(isSupportedVideoDestination("youtube")).toBe(true);
  });

  it("enforces YouTube title/description limits and required choices", () => {
    const m = defaultVideoMetadata("youtube", "t", "d");
    expect(validateVideoMetadata({ ...m, title: "x".repeat(101) }, chosen)).toContain(
      "YouTube titles must be 100 characters or fewer.",
    );
    expect(validateVideoMetadata({ ...m, description: "x".repeat(5001) }, chosen).length).toBe(1);
    // 2,000 three-byte characters = 6,000 UTF-8 bytes: over the limit despite 2,000 chars.
    expect(validateVideoMetadata({ ...m, description: "\u0C24".repeat(2000) }, chosen).join(" ")).toMatch(/bytes/);
    expect(validateVideoMetadata({ ...m, description: "\u0C24".repeat(1666) }, chosen)).toEqual([]);
    expect(validateVideoMetadata(m, { audienceChosen: false, privacyChosen: false })).toHaveLength(2);
    expect(validateVideoMetadata(m, chosen)).toEqual([]);
  });

  it("only allows public reels on Facebook", () => {
    const m = defaultVideoMetadata("facebook", "t", "d");
    expect(validateVideoMetadata({ ...m, privacy: "private" }, chosen).length).toBeGreaterThan(0);
    expect(validateVideoMetadata({ ...m, format: "video" }, chosen).length).toBeGreaterThan(0);
    expect(normalizeForDestination({ ...m, privacy: "unlisted", format: "video" })).toMatchObject({ privacy: "public", format: "reel" });
    expect(VIDEO_DESTINATION_SPECS.facebook.join(" ")).toMatch(/540x960/);
  });

  it("explains the Google audit and Shorts eligibility", () => {
    const yt = VIDEO_DESTINATION_SPECS.youtube.join(" ");
    expect(yt).toMatch(/audit/);
    expect(yt).toMatch(/not guaranteed/);
  });

  it("never resubmits any enqueued outcome, including definitive failures", () => {
    expect(canSubmitVideoDestination("youtube", [])).toEqual({ allowed: true });
    for (const state of ["queued", "uploading", "published", "attention", "failed"]) {
      expect(canSubmitVideoDestination("youtube", [{ platform: "youtube", state }]).allowed).toBe(false);
    }
    expect(canSubmitVideoDestination("youtube", [{ platform: "youtube", state: "failed" }]).reason).toMatch(/new Library item/);
    expect(canSubmitVideoDestination("youtube", [{ platform: "youtube", state: "uploading", error: "Token revoked." }]).reason).toMatch(/resumes automatically after you reconnect/);
    expect(canSubmitVideoDestination("facebook", [{ platform: "youtube", state: "published" }]).allowed).toBe(true);
  });

  it("caps generated YouTube titles at 100", () => {
    expect(() => formatVideoLibraryCopy({ title: "x".repeat(101), caption: "c", hashtags: [] }, "youtube")).toThrow(/100/);
    expect(formatVideoLibraryCopy({ title: "Ok", caption: "c", hashtags: ["a"] }, "youtube").title).toBe("Ok");
  });
});
