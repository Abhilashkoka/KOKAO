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
