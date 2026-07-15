import { describe, it, expect } from "vitest";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  trimToTweetLength,
  splitIntoTweets,
  LINKEDIN_MAX_LENGTH,
  LINKEDIN_COMMENT_MAX_LENGTH,
  chunkOnWhitespace,
  splitForLinkedin,
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

describe("splitIntoTweets", () => {
  it("returns a single tweet when within the limit", () => {
    expect(splitIntoTweets("short caption")).toEqual(["short caption"]);
    const exact = "a".repeat(TWEET_MAX_LENGTH);
    expect(splitIntoTweets(exact)).toEqual([exact]);
  });

  it("trims surrounding whitespace before measuring", () => {
    expect(splitIntoTweets("  hello world  ")).toEqual(["hello world"]);
  });

  it("splits on word boundaries and keeps every tweet within the limit", () => {
    const caption = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const tweets = splitIntoTweets(caption);
    expect(tweets.length).toBeGreaterThan(1);
    for (const t of tweets) {
      expect(t.length).toBeLessThanOrEqual(TWEET_MAX_LENGTH);
      // Word boundaries preserved: no tweet starts or ends mid-word.
      expect(t).toBe(t.trim());
    }
    // No content lost: every word survives the split, in order.
    const rejoinedWords = tweets.join(" ").split(/\s+/);
    expect(rejoinedWords).toEqual(caption.split(" "));
  });

  it("never cuts a word in half when splitting on boundaries", () => {
    const caption = "aaaa bbbb cccc dddd eeee".repeat(20);
    const tweets = splitIntoTweets(caption, 20);
    for (const t of tweets) {
      expect(t.length).toBeLessThanOrEqual(20);
    }
  });

  it("hard-splits a single token longer than a whole tweet", () => {
    const caption = "b".repeat(700);
    const tweets = splitIntoTweets(caption);
    expect(tweets.length).toBe(3);
    for (const t of tweets) {
      expect(t.length).toBeLessThanOrEqual(TWEET_MAX_LENGTH);
    }
    expect(tweets.join("")).toBe(caption);
  });

  it("hard-splits an oversized token embedded between normal words", () => {
    const giant = "x".repeat(600);
    const tweets = splitIntoTweets(`intro ${giant} outro`);
    for (const t of tweets) {
      expect(t.length).toBeLessThanOrEqual(TWEET_MAX_LENGTH);
    }
    expect(tweets.join("")).toContain(giant.slice(0, TWEET_MAX_LENGTH));
    expect(tweets[0]).toBe("intro");
    expect(tweets[tweets.length - 1]!.endsWith("outro")).toBe(true);
  });

  it("respects a custom maxLength", () => {
    const tweets = splitIntoTweets("aaaa bbbb cccc", 9);
    expect(tweets).toEqual(["aaaa bbbb", "cccc"]);
  });

  it("returns a single empty tweet for empty or whitespace-only input", () => {
    expect(splitIntoTweets("")).toEqual([""]);
    expect(splitIntoTweets("   ")).toEqual([""]);
  });
});

describe("chunkOnWhitespace", () => {
  it("returns an empty array for empty or whitespace-only input", () => {
    expect(chunkOnWhitespace("", 10)).toEqual([]);
    expect(chunkOnWhitespace("   \n ", 10)).toEqual([]);
  });

  it("returns a single chunk when the text is within the limit", () => {
    expect(chunkOnWhitespace("hello world", 100)).toEqual(["hello world"]);
  });

  it("splits on whitespace so words are never cut in half", () => {
    const chunks = chunkOnWhitespace("aaaa bbbb cccc dddd", 10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    // Re-joining with a single space reproduces the original words in order.
    expect(chunks.join(" ")).toBe("aaaa bbbb cccc dddd");
  });

  it("hard-splits a single token longer than the limit", () => {
    const chunks = chunkOnWhitespace("a".repeat(25), 10);
    expect(chunks).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
  });

  it("keeps every chunk within the limit for mixed content", () => {
    const text = ("word ".repeat(50) + "x".repeat(40)).trim();
    for (const c of chunkOnWhitespace(text, 30)) {
      expect(c.length).toBeLessThanOrEqual(30);
    }
  });

  it("throws on a non-positive limit", () => {
    expect(() => chunkOnWhitespace("hi", 0)).toThrow();
  });
});

describe("splitForLinkedin", () => {
  it("returns text within the post limit as the main post with no comments", () => {
    const text = "a short caption";
    expect(splitForLinkedin(text)).toEqual({ main: text, comments: [] });
  });

  it("does not spill a caption exactly at the post limit into comments", () => {
    const text = "a".repeat(LINKEDIN_MAX_LENGTH);
    const { main, comments } = splitForLinkedin(text);
    expect(main.length).toBe(LINKEDIN_MAX_LENGTH);
    expect(comments).toEqual([]);
  });

  it("keeps the first chunk as the post and the remainder as comments", () => {
    const text = "lorem ".repeat(800).trim();
    const { main, comments } = splitForLinkedin(text);
    expect(main.length).toBeLessThanOrEqual(LINKEDIN_MAX_LENGTH);
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) {
      expect(c.length).toBeLessThanOrEqual(LINKEDIN_COMMENT_MAX_LENGTH);
    }
  });

  it("preserves the full caption text across the post and comments (nothing dropped)", () => {
    const text = "lorem ".repeat(800).trim();
    const { main, comments } = splitForLinkedin(text);
    // Strip the "(i/n) " ordering prefixes before re-joining: the visible
    // words must reproduce the caption in order with nothing dropped.
    const stripped = comments.map((c) => c.replace(/^\(\d+\/\d+\) /, ""));
    expect([main, ...stripped].join(" ")).toBe(text);
  });

  it("numbers multi-comment overflow so readers can follow the order", () => {
    const text = "lorem ".repeat(800).trim();
    const { comments } = splitForLinkedin(text);
    expect(comments.length).toBeGreaterThan(1);
    comments.forEach((c, i) => {
      expect(c.startsWith(`(${i + 1}/${comments.length}) `)).toBe(true);
      expect(c.length).toBeLessThanOrEqual(LINKEDIN_COMMENT_MAX_LENGTH);
    });
  });

  it("leaves a single overflow comment unnumbered", () => {
    // Just over the post limit: the remainder fits in one comment.
    const text = ("word ".repeat(LINKEDIN_MAX_LENGTH / 5) + "tail extra").trim();
    const { comments } = splitForLinkedin(text);
    expect(comments.length).toBe(1);
    expect(comments[0]).not.toMatch(/^\(\d+\/\d+\) /);
  });
});
