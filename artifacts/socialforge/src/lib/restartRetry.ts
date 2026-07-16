/**
 * Automatic one-shot retry for publishes rejected during a server restart.
 * Implementation lives in the shared @workspace/api-client-react lib so the
 * web and mobile apps stay in lockstep; this module re-exports it for
 * existing imports and tests.
 */
export {
  RESTART_RETRY_DELAY_MS,
  isRestartRejection,
  isNetworkFailure,
  transientRetryReason,
  mutateWithRestartRetry,
} from "@workspace/api-client-react";
export type { RestartRetryCallbacks, RetryReason } from "@workspace/api-client-react";
