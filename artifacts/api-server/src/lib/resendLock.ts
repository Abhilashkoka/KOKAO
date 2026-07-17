/**
 * In-process per-content-item resend locks.
 *
 * Two truly simultaneous resend requests both read the same persisted chain
 * state and both probe recent posts BEFORE either has posted, so the dedupe
 * probe cannot see the other request's writes — without a guard both could
 * post the same pieces. The API server runs as a single process, so a simple
 * in-memory lock keyed by platform + content-item id is sufficient: the
 * second overlapping request is rejected immediately with a friendly
 * "already resending" response instead of racing.
 */
const activeResends = new Set<string>();

/**
 * Try to acquire the resend lock for a content item on a platform. Returns a
 * release function when acquired, or null when a resend is already running.
 * The caller MUST call the release function in a finally block.
 */
export function tryAcquireResendLock(
  platform: string,
  contentItemId: number,
): (() => void) | null {
  const key = `${platform}:${contentItemId}`;
  if (activeResends.has(key)) return null;
  activeResends.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeResends.delete(key);
  };
}

export const RESEND_IN_PROGRESS_MESSAGE =
  "A resend for this post is already in progress. Wait a moment for it to finish, then check the result before trying again.";
