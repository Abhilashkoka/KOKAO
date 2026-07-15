import type { Server } from "node:http";
import { logger } from "./logger";
import { waitForPendingJobs } from "./backgroundJobs";

/**
 * Graceful shutdown: stop accepting new connections, then drain any in-flight
 * background publish jobs so they finish (and persist their outcome) instead of
 * being killed mid-flight and orphaned. Bounded by a timeout so a stuck job
 * can't block shutdown indefinitely.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  server: Pick<Server, "close">;
  /** Injectable for tests; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Injectable for tests; defaults to SHUTDOWN_DRAIN_TIMEOUT_MS. */
  drainTimeoutMs?: number;
  /** Injectable for tests; defaults to waitForPendingJobs. */
  drain?: () => Promise<void>;
}

/**
 * Returns a signal handler that closes the server, drains in-flight background
 * jobs (bounded by `drainTimeoutMs`), then exits. Re-entrant calls (a second
 * SIGTERM/SIGINT) are ignored while a shutdown is already in progress.
 */
export function createShutdownHandler(options: ShutdownOptions) {
  const {
    server,
    exit = (code: number) => process.exit(code),
    drainTimeoutMs = SHUTDOWN_DRAIN_TIMEOUT_MS,
    drain = waitForPendingJobs,
  } = options;

  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down: draining in-flight jobs");

    server.close();

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainTimeoutMs);
        }),
      ]);
    } catch (err) {
      logger.error({ err }, "Error while draining jobs during shutdown");
    } finally {
      if (timer) clearTimeout(timer);
    }

    exit(0);
  };
}
