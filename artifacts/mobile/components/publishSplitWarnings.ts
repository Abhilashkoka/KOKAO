import {
  TWEET_MAX_LENGTH,
  THREADS_MAX_LENGTH,
  splitForLinkedin,
  splitIntoTweets,
  chunkOnWhitespace,
  isOverLinkedinLimit,
} from "@workspace/social-limits";

export interface SplitWarningPlatforms {
  linkedinReady: boolean;
  twitterReady: boolean;
  threadsReady: boolean;
}

/**
 * Derives the over-limit split warnings shown on the content detail screen's
 * publish section. Counts come from the shared @workspace/social-limits
 * helpers so the previewed thread/chain/comment counts always match what
 * publishing will actually produce.
 */
export function buildSplitWarnings(
  captionText: string,
  { linkedinReady, twitterReady, threadsReady }: SplitWarningPlatforms,
): string[] {
  const warnings: string[] = [];
  if (linkedinReady && isOverLinkedinLimit(captionText)) {
    const liSplit = splitForLinkedin(captionText);
    warnings.push(
      `LinkedIn: this caption is over the limit, so the rest will be added as ${liSplit.comments.length} comment(s).`,
    );
  }
  if (twitterReady && captionText.length > TWEET_MAX_LENGTH) {
    const tweetChunks = splitIntoTweets(captionText);
    warnings.push(
      `X: this caption is over the ${TWEET_MAX_LENGTH}-character limit, so it will post as a thread of ${tweetChunks.length} tweets.`,
    );
  }
  if (threadsReady && captionText.length > THREADS_MAX_LENGTH) {
    const threadsChunks = chunkOnWhitespace(captionText, THREADS_MAX_LENGTH);
    warnings.push(
      `Threads: this caption is over the ${THREADS_MAX_LENGTH}-character limit, so it will post as a chain of ${threadsChunks.length} connected posts.`,
    );
  }
  return warnings;
}
