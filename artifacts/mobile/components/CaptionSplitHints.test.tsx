/**
 * Guard: the mobile Studio caption length hints must be derived from the
 * shared @workspace/social-limits helpers and use the same wording as the
 * web Studio (artifacts/socialforge/src/pages/studio.test.tsx), so a change
 * to platform limits or hint phrasing can't silently diverge between apps.
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  TWEET_MAX_LENGTH,
  splitIntoTweets,
  tweetOverBy,
  THREADS_MAX_LENGTH,
  chunkOnWhitespace,
  LINKEDIN_MAX_LENGTH,
  isOverLinkedinLimit,
  splitForLinkedin,
} from "@workspace/social-limits";

import { CaptionSplitHints } from "./CaptionSplitHints";

describe("CaptionSplitHints X character counter", () => {
  it("shows an under-limit counter without a thread warning", () => {
    const caption = "A perfectly fine short caption.";
    render(<CaptionSplitHints text={caption} platform="x" />);
    expect(
      screen.getByText(`${caption.length} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("shows no thread warning exactly at the limit", () => {
    const caption = "x".repeat(TWEET_MAX_LENGTH);
    render(<CaptionSplitHints text={caption} platform="x" />);
    expect(
      screen.getByText(`${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("warns with the shared helper's tweet count when over the X limit", () => {
    const caption = "word ".repeat(80).trim();
    expect(caption.length).toBeGreaterThan(TWEET_MAX_LENGTH);
    render(<CaptionSplitHints text={caption} platform="x" />);
    const hint = screen.getByText(`${caption.length} / ${TWEET_MAX_LENGTH} characters for X`, {
      exact: false,
    });
    expect(hint.textContent).toContain(`${tweetOverBy(caption)} over`);
    expect(hint.textContent).toContain(
      `will post as a thread of ${splitIntoTweets(caption).length} tweets on X`,
    );
  });

  it("renders nothing for platforms without length hints", () => {
    const { container } = render(
      <CaptionSplitHints text={"x".repeat(5000)} platform="instagram" />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("CaptionSplitHints Threads character counter", () => {
  it("shows an under-limit counter without a chain warning", () => {
    const caption = "A perfectly fine short caption for Threads.";
    render(<CaptionSplitHints text={caption} platform="threads" />);
    expect(
      screen.getByText(`${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/chain of/i)).toBeNull();
  });

  it("warns with the shared helper's chunk count when over the Threads limit", () => {
    const caption = "t".repeat(THREADS_MAX_LENGTH + 60);
    const chunks = chunkOnWhitespace(caption, THREADS_MAX_LENGTH);
    render(<CaptionSplitHints text={caption} platform="threads" />);
    const hint = screen.getByText(
      `${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`,
      { exact: false },
    );
    expect(hint.textContent).toContain(
      `will post as a chain of ${chunks.length} connected posts on Threads`,
    );
  });
});

describe("CaptionSplitHints LinkedIn character counter", () => {
  it("shows an under-limit counter without a comment warning", () => {
    const caption = "A perfectly fine short caption for LinkedIn.";
    expect(isOverLinkedinLimit(caption)).toBe(false);
    render(<CaptionSplitHints text={caption} platform="linkedin" />);
    expect(
      screen.getByText(`${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/follow-up comment/i)).toBeNull();
  });

  it("warns with the shared helper's comment count when over the LinkedIn limit", () => {
    const caption = "l".repeat(LINKEDIN_MAX_LENGTH + 200);
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const commentCount = splitForLinkedin(caption).comments.length;
    render(<CaptionSplitHints text={caption} platform="linkedin" />);
    const hint = screen.getByText(
      `${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`,
      { exact: false },
    );
    expect(hint.textContent).toContain(
      `the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"} on LinkedIn`,
    );
  });
});

describe("CaptionSplitHints on X shows all three platform counters", () => {
  it("renders X, Threads, and LinkedIn counters for platform x", () => {
    const caption = "A short caption.";
    render(<CaptionSplitHints text={caption} platform="x" />);
    expect(screen.getByText(/characters for X/)).toBeTruthy();
    expect(screen.getByText(/characters for Threads/)).toBeTruthy();
    expect(screen.getByText(/characters for LinkedIn/)).toBeTruthy();
  });
});
