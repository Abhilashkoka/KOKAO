import type { Server } from "node:http";
import { assertRequiredEnv } from "./lib/assertEnv";
import app from "./app";
import { logger } from "./lib/logger";
import { recoverStuckPublishingItems } from "./lib/recoverStuckPublishes";
import { createShutdownHandler } from "./lib/shutdown";

// Fail loudly before binding if a deployed context is missing required env,
// rather than booting into a silently-degraded state.
assertRequiredEnv();

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

// Graceful shutdown: drain in-flight background publish jobs (bounded by a
// timeout) before exiting. Logic lives in lib/shutdown.ts so it is testable.
const shutdown = createShutdownHandler({ server });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
