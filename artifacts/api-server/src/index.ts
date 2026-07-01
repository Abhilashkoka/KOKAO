import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { recoverStuckPublishingItems } from "./lib/recoverStuckPublishes";
import { waitForPendingJobs } from "./lib/backgroundJobs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server: Server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // A freshly started process has no in-flight background jobs, so any content
  // item still stuck on "publishing" is an orphan left behind by a previous
  // process that restarted/crashed mid-publish. Reclaim them so they don't hang
  // forever. Runs after we're listening so recovery never delays startup, and
  // it swallows its own errors.
  void recoverStuckPublishingItems();
});

/**
 * Graceful shutdown: stop accepting new connections, then drain any in-flight
 * background publish jobs so they finish (and persist their outcome) instead of
 * being killed mid-flight and orphaned. Bounded by a timeout so a stuck job
 * can't block shutdown indefinitely.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down: draining in-flight jobs");

  server.close();

  try {
    await Promise.race([
      waitForPendingJobs(),
      new Promise<void>((resolve) =>
        setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.error({ err }, "Error while draining jobs during shutdown");
  }

  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
