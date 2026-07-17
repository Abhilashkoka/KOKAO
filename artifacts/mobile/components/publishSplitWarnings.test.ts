/**
 * Guard: the content detail screen's publish split warnings
 * (app/content/[id].tsx via buildSplitWarnings) must derive their previewed
 * X tweet count, Threads chain count, and LinkedIn comment count from the
 * shared @workspace/social-limits helpers, so a limits or wording change
 * can't silently desync the mobile preview from what publishing produces.
 */
import { describe, it, expect } from "vitest";
import {
  TWEET_MAX_LENGTH,
  THREADS_MAX_LENGTH,
  LINKEDIN_MAX_LENGTH,
  splitForLinkedin,
  splitIntoTweets,
  chunkOnWhitespace,
  isOverLinkedinLimit,
} from "@workspace/social-limits";

import { buildSplitWarnings } from "./publishSplitWarnings";

const allReady = { linkedinReady: true, twitterReady: true, threadsReady: true };

describe("buildSplitWarnings", () => {
  it("returns no warnings for a short caption on all platforms", () => {
    expect(buildSplitWarnings("A perfectly fine short caption.", allReady)).toEqual([]);
  });

  it("returns no warnings for captions exactly at each limit", () => {
    expect(buildSplitWarnings("x".repeat(TWEET_MAX_LENGTH), allReady)).toEqual([]);
    const atThreads = "x".repeat(THREADS_MAX_LENGTH);
    expect(
      buildSplitWarnings(atThreads, allReady).some((w) => w.startsWith("Threads:")),
    ).toBe(false);
  });

  it("previews the X thread count from splitIntoTweets", () => {
    const caption = "word ".repeat(120).trim();
    expect(caption.length).toBeGreaterThan(TWEET_MAX_LENGTH);
    const warnings = buildSplitWarnings(caption, allReady);
    const xWarning = warnings.find((w) => w.startsWith("X:"));
    expect(xWarning).toBe(
      `X: this caption is over the ${TWEET_MAX_LENGTH}-character limit, so it will post as a thread of ${splitIntoTweets(caption).length} tweets.`,
    );
  });

  it("previews the Threads chain count from chunkOnWhitespace", () => {
    const caption = "word ".repeat(300).trim();
    expect(caption.length).toBeGreaterThan(THREADS_MAX_LENGTH);
    const warnings = buildSplitWarnings(caption, allReady);
    const thWarning = warnings.find((w) => w.startsWith("Threads:"));
    expect(thWarning).toBe(
      `Threads: this caption is over the ${THREADS_MAX_LENGTH}-character limit, so it will post as a chain of ${chunkOnWhitespace(caption, THREADS_MAX_LENGTH).length} connected posts.`,
    );
  });

  it("previews the LinkedIn comment count from splitForLinkedin", () => {
    const caption = "word ".repeat(Math.ceil(LINKEDIN_MAX_LENGTH / 5) + 200).trim();
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const warnings = buildSplitWarnings(caption, allReady);
    const liWarning = warnings.find((w) => w.startsWith("LinkedIn:"));
    expect(liWarning).toBe(
      `LinkedIn: this caption is over the limit, so the rest will be added as ${splitForLinkedin(caption).comments.length} comment(s).`,
    );
  });

  it("only warns for platforms that are ready to publish", () => {
    const caption = "word ".repeat(Math.ceil(LINKEDIN_MAX_LENGTH / 5) + 200).trim();
    expect(buildSplitWarnings(caption, allReady)).toHaveLength(3);
    expect(
      buildSplitWarnings(caption, {
        linkedinReady: false,
        twitterReady: true,
        threadsReady: false,
      }).map((w) => w.split(":")[0]),
    ).toEqual(["X"]);
    expect(
      buildSplitWarnings(caption, {
        linkedinReady: false,
        twitterReady: false,
        threadsReady: false,
      }),
    ).toEqual([]);
  });
});
