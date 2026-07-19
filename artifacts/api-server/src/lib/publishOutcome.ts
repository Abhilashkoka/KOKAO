/**
 * Shared result type for the per-platform publish "core" functions.
 *
 * Each route file (meta.ts, linkedin.ts, twitter.ts, threads.ts) exports a
 * `publish<Platform>Core(tenantId, contentItemId)` function containing the
 * full publish flow — credential re-verify + load, post-text building,
 * duplicate-post probing, the platform write, content-item status updates and
 * taste signals — WITHOUT any req/res dependency, so the same flow can be
 * driven both by the manual publish HTTP handlers and by the scheduled-publish
 * executor.
 *
 * Contract:
 * - The core owns persisting the content item's final status
 *   ("published"/"failed") and any account verifyStatus flips; callers only
 *   translate the outcome (HTTP response, or scheduled-post row update).
 * - The core does NOT acquire the per-item publish lock; callers must hold it
 *   (route handlers and the executor both use tryAcquireResendLock).
 * - `errorStatus` mirrors the HTTP status the manual endpoint used to send,
 *   so route handlers stay byte-for-byte compatible.
 */
export type PublishOutcome =
  | {
      ok: true;
      postId: string | null;
      permalink: string | null;
      /** Non-fatal follow-up problem (e.g. a thread/comment chain broke after
       * the first post landed). The item is still "published". */
      warning?: string;
      /** Extra fields the manual endpoint returned (chain state etc.). */
      extra?: Record<string, unknown>;
    }
  | {
      ok: false;
      /** HTTP status the manual endpoint would respond with (400/404/502...). */
      errorStatus: number;
      error: string;
      /** True when the item was left in a state where the publish may still
       * complete in the background (Instagram enqueue refusal at shutdown). */
      retryable?: boolean;
    };
