import { describe, it, expect } from "vitest";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  trimToTweetLength,
} from "./index";

const ELLIPSIS = "\u2026";

describe("TWEET_MAX_LENGTH", () => {
  it("is the X/Twitter 280-character limit", () => {
    expect(TWEET_MAX_LENGTH).toBe(280);
  });
});

describe("isOverTweetLimit", () => {
  it("is false for empty text", () => {
    expect(isOverTweetLimit("")).toBe(false);
  });

  it("is false for text shorter than the limit", () => {
    expect(isOverTweetLimit("a".repeat(279))).toBe(false);
  });

  it("is false for text exactly at the limit", () => {
    expect(isOverTweetLimit("a".repeat(TWEET_MAX_LENGTH))).toBe(false);
  });

  it("is true for text one character over the limit", () => {
    expect(isOverTweetLimit("a".repeat(TWEET_MAX_LENGTH + 1))).toBe(true);
  });
});

describe("tweetOverBy", () => {
  it("returns 0 for empty text", () => {
    expect(tweetOverBy("")).toBe(0);
  });

  it("returns 0 for text exactly at the limit", () => {
    expect(tweetOverBy("a".repeat(TWEET_MAX_LENGTH))).toBe(0);
  });

  it("never returns a negative number for under-limit text", () => {
    expect(tweetOverBy("a".repeat(100))).toBe(0);
  });

  it("returns the exact overage for text past the limit", () => {
    expect(tweetOverBy("a".repeat(TWEET_MAX_LENGTH + 5))).toBe(5);
  });
});

describe("trimToTweetLength", () => {
  it("leaves empty text untouched", () => {
    expect(trimToTweetLength("")).toBe("");
  });

  it("leaves text shorter than the limit untouched", () => {
    const text = "a".repeat(100);
    expect(trimToTweetLength(text)).toBe(text);
  });

  it("does not trim text exactly at the 280-char limit", () => {
    const text = "a".repeat(TWEET_MAX_LENGTH);
    const result = trimToTweetLength(text);
    expect(result).toBe(text);
    expect(result.length).toBe(TWEET_MAX_LENGTH);
    expect(result.endsWith(ELLIPSIS)).toBe(false);
  });

  it("trims text over the limit to slice(0, 279).trimEnd() + ellipsis", () => {
    const text = "a".repeat(500);
    const expected = text.slice(0, TWEET_MAX_LENGTH - 1).trimEnd() + ELLIPSIS;
    const result = trimToTweetLength(text);
    expect(result).toBe(expected);
    expect(result.length).toBe(TWEET_MAX_LENGTH);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
  });

  it("trims trailing whitespace before appending the ellipsis", () => {
    const text = "a".repeat(TWEET_MAX_LENGTH - 1) + " " + "b".repeat(50);
    const result = trimToTweetLength(text);
    expect(result).toBe("a".repeat(TWEET_MAX_LENGTH - 1) + ELLIPSIS);
    expect(result.length).toBe(TWEET_MAX_LENGTH);
  });

  it("stays within the limit for text one character over", () => {
    const result = trimToTweetLength("a".repeat(TWEET_MAX_LENGTH + 1));
    expect(result.length).toBeLessThanOrEqual(TWEET_MAX_LENGTH);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
  });

  it("keeps the warning and the trim in agreement: any over-limit text becomes exactly the limit", () => {
    for (const len of [281, 300, 500, 1000]) {
      const text = "a".repeat(len);
      expect(isOverTweetLimit(text)).toBe(true);
      expect(trimToTweetLength(text).length).toBe(TWEET_MAX_LENGTH);
    }
  });
});
