export const TWEET_MAX_LENGTH = 280;

const ELLIPSIS = "\u2026";

export function isOverTweetLimit(text: string): boolean {
  return text.length > TWEET_MAX_LENGTH;
}

export function tweetOverBy(text: string): number {
  return Math.max(0, text.length - TWEET_MAX_LENGTH);
}

export function trimToTweetLength(text: string): string {
  if (text.length <= TWEET_MAX_LENGTH) return text;
  return text.slice(0, TWEET_MAX_LENGTH - 1).trimEnd() + ELLIPSIS;
}

/**
 * Split a caption into a sequence of tweets, each within `maxLength`, so a
 * long post can be published as a reply-chained thread instead of being
 * truncated. Splitting prefers word boundaries and only hard-splits a single
 * token that is itself longer than `maxLength`.
 *
 * Always returns at least one tweet (an empty input yields `[""]`), so callers
 * can post the first tweet unconditionally. Shared by the server publish route
 * and the Library preview so the previewed thread count can never drift from
 * what actually posts.
 */
export function splitIntoTweets(
  text: string,
  maxLength: number = TWEET_MAX_LENGTH,
): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const tweets: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      tweets.push(trimmed);
    }
    current = "";
  };

  // Break the text into atomic tokens: runs of whitespace are preserved as
  // separators so we can rejoin without losing paragraph breaks.
  const tokens = normalized.match(/\s+|\S+/g) ?? [];

  for (const token of tokens) {
    if (current.length + token.length <= maxLength) {
      current += token;
      continue;
    }

    // The token doesn't fit on the current tweet.
    if (/^\s+$/.test(token)) {
      // Whitespace separator: just start a new tweet, dropping the break.
      flush();
      continue;
    }

    // A non-whitespace token that doesn't fit: flush what we have first.
    flush();

    if (token.length <= maxLength) {
      current = token;
      continue;
    }

    // A single token longer than a whole tweet: hard-split it into pieces.
    let rest = token;
    while (rest.length > maxLength) {
      tweets.push(rest.slice(0, maxLength));
      rest = rest.slice(maxLength);
    }
    current = rest;
  }

  flush();

  return tweets.length > 0 ? tweets : [""];
}

export const LINKEDIN_MAX_LENGTH = 3000;

export function isOverLinkedinLimit(text: string): boolean {
  return text.length > LINKEDIN_MAX_LENGTH;
}

export function linkedinOverBy(text: string): number {
  return Math.max(0, text.length - LINKEDIN_MAX_LENGTH);
}

export function trimToLinkedinLength(text: string): string {
  if (text.length <= LINKEDIN_MAX_LENGTH) return text;
  return text.slice(0, LINKEDIN_MAX_LENGTH - 1).trimEnd() + ELLIPSIS;
}

/** Threads posts are capped at 500 characters of text. */
export const THREADS_MAX_LENGTH = 500;

/**
 * LinkedIn comments have a smaller character budget than posts (~1250 chars),
 * so caption overflow that spills into follow-up comments must be chunked to
 * this limit, not the 3000-char post limit.
 */
export const LINKEDIN_COMMENT_MAX_LENGTH = 1250;

/**
 * Break `text` into pieces no longer than `limit`, preferring to split on
 * whitespace so words aren't cut in half. A single token longer than `limit`
 * (e.g. a giant URL) is hard-split at the limit as a last resort. Returns an
 * empty array for empty/whitespace-only input.
 */
export function chunkOnWhitespace(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error("limit must be a positive number");
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let breakAt = -1;
    for (let i = limit; i > 0; i--) {
      if (/\s/.test(remaining[i]!)) {
        breakAt = i;
        break;
      }
    }
    // No whitespace within the window: hard-split a single oversized token.
    if (breakAt <= 0) breakAt = limit;
    const piece = remaining.slice(0, breakAt).trimEnd();
    if (piece.length > 0) chunks.push(piece);
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Split a LinkedIn caption into a main post plus zero or more follow-up
 * comments. Text within the post limit is returned as the main post with no
 * comments. Overflow keeps the first post-limit-sized chunk as the main post
 * and packs the remainder into comment-limit-sized chunks, splitting on
 * whitespace where possible so the full message still reaches readers.
 */
export function splitForLinkedin(text: string): {
  main: string;
  comments: string[];
} {
  const trimmed = text.trim();
  if (trimmed.length <= LINKEDIN_MAX_LENGTH) {
    return { main: trimmed, comments: [] };
  }
  const main = chunkOnWhitespace(trimmed, LINKEDIN_MAX_LENGTH)[0] ?? "";
  const remainder = trimmed.slice(main.length).trimStart();
  const comments = remainder
    ? numberLinkedinComments(remainder, LINKEDIN_COMMENT_MAX_LENGTH)
    : [];
  return { main, comments };
}

/**
 * Chunk overflow text into comments, prefixing each with its position
 * ("(2/4) ...") when there is more than one comment so readers can follow
 * the intended order even if LinkedIn reorders comments. The prefix counts
 * toward the per-comment limit; a single comment is returned unnumbered.
 */
function numberLinkedinComments(text: string, limit: number): string[] {
  const plain = chunkOnWhitespace(text, limit);
  if (plain.length <= 1) return plain;
  // Reserve room for the "(i/n) " prefix. The prefix length depends on the
  // final count, which itself depends on the reserved room, so iterate until
  // the count is stable (grows monotonically, so this terminates quickly).
  let count = plain.length;
  let chunks = plain;
  for (;;) {
    const prefixLen = `(${count}/${count}) `.length;
    const next = chunkOnWhitespace(text, Math.max(1, limit - prefixLen));
    if (next.length <= count) {
      chunks = next;
      break;
    }
    count = next.length;
    chunks = next;
  }
  const total = chunks.length;
  if (total <= 1) return chunks;
  return chunks.map((chunk, i) => `(${i + 1}/${total}) ${chunk}`);
}
