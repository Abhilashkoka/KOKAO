import type { Server } from "node:http";
import { assertRequiredEnv } from "./lib/assertEnv";
import app from "./app";
import { logger } from "./lib/logger";
import { recoverStuckPublishingItems } from "./lib/recoverStuckPublishes";
import { createShutdownHandler } from "./lib/shutdown";
import { startConnectionSweep, stopConnectionSweep } from "./lib/connectionSweep";
import { startFxRateSweep, stopFxRateSweep } from "./lib/fxRateSweep";
import {
  startScheduledPublisher,
  stopScheduledPublisher,
} from "./lib/scheduledPublisher";
import {
  startPushTokenMaintenance,
  stopPushTokenMaintenance,
} from "./lib/push";
import {
  startPostMetricsSweep,
  stopPostMetricsSweep,
} from "./lib/postMetricsSweep";
import { startImageJobSweep, stopImageJobSweep } from "./lib/imageJobs";
import { sweepDuplicateModelPrices } from "./lib/aiCost";
import {
  sweepStuckPendingTrueUps,
  startTrueUpRetrySweep,
  stopTrueUpRetrySweep,
  initTrueUpFailCounts,
  sweepWalletSettlementRetries,
  startWalletSettlementRetrySweep,
  stopWalletSettlementRetrySweep,
} from "./lib/wallet";
import { startVideoJobSweep, stopVideoJobSweep } from "./lib/videoGen/videoJobSweep";
import {
  startBrandVoiceExtractedSampleSweep,
  stopBrandVoiceExtractedSampleSweep,
} from "./lib/brandVoiceExtractedSamples";
import {
  recoverBrandVoiceCloneProviderOperations,
  startWalletProviderRecovery,
  stopWalletProviderRecovery,
} from "./lib/walletProviderRecovery";

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

  // One-time cleanup per boot: merge ai_model_prices rows differing only in
  // case/whitespace (historical duplicates from before saves normalized the
  // key), keeping the most recently updated prices. Audited, best-effort.
  // Load persisted true-up fail counts FIRST so the consecutive-failure alert
  // threshold is measured across the real failure duration (not just since last
  // boot), then dedupe prices, then run the true-up sweep — all chained so the
  // sweep never races the count load.
  // Keep retrying pending wallet true-ups in the background: a price that
  // already exists in the catalog must eventually be applied even when the
  // fire-and-forget hook on price save failed, without waiting for a reboot
  // or forcing the admin to re-save the price.
  //
  // These true-up steps are chained so initialization completes before its
  // first periodic tick can increment a count.
  void initTrueUpFailCounts()
    .then(() => sweepDuplicateModelPrices())
    .then(() => sweepStuckPendingTrueUps())
    .then(() => {
      startTrueUpRetrySweep();
    })
    .catch((error) => {
      logger.error({ err: error }, "Wallet true-up retry initialization failed");
    });

  // Settlement recovery must not depend on true-up initialization: a transient
  // failure in the price-reconciliation path must never strand already
  // successful AI work with only its reservation debit.
  void sweepWalletSettlementRetries()
    .catch((error) => {
      logger.error({ err: error }, "Wallet settlement retry initialization failed");
    })
    .finally(() => {
      startWalletSettlementRetrySweep();
    });

  // Reconcile the earlier crash boundary as well: provider work that finished
  // before its reservation reached the settlement outbox. Brand Voice can also
  // resolve a response-loss gap by looking up its deterministic provider name.
  void recoverBrandVoiceCloneProviderOperations()
    .catch((error) => {
      logger.error({ err: error }, "Wallet provider-operation recovery initialization failed");
    })
    .finally(() => {
      startWalletProviderRecovery();
    });

  // Periodically re-verify every tenant's stored social connections in the
  // background so an expired/revoked token triggers the breakage notification
  // even for users who never open the Accounts page.
  startConnectionSweep();

  // Periodically publish scheduled posts whose time has arrived, using the
  // same per-platform publish cores as the manual publish endpoints.
  startScheduledPublisher();

  // Periodically resolve delayed Expo push receipts (deleting tokens whose
  // receipts report DeviceNotRegistered) and prune tokens whose device
  // hasn't re-registered in months (uninstalled apps never error).
  startPushTokenMaintenance();

  // Periodically pull per-post engagement metrics back from the platforms
  // for recently published posts (gated by the postMetrics kill switch).
  startPostMetricsSweep();

  // Periodically fail out image jobs abandoned in queued/processing by a
  // restart (the background runner is in-process), refunding credit funding.
  startImageJobSweep();

  // Remove private voice samples that were extracted for review but never
  // adopted by a successful clone (for example after a browser crash).
  startBrandVoiceExtractedSampleSweep();

  // Periodically settle video jobs that cannot settle themselves: storyboards
  // whose review window closed, and jobs orphaned in queued/processing by a
  // restart. Both refund credit funding.
  startVideoJobSweep();

  // Once a day, fetch the live USD→INR market rate, add the configured
  // markup, and save it as the AI-cost conversion rate.
  startFxRateSweep();
});

// Graceful shutdown: drain in-flight background publish jobs (bounded by a
// timeout) before exiting. Logic lives in lib/shutdown.ts so it is testable.
const shutdown = createShutdownHandler({ server });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopConnectionSweep();
    stopScheduledPublisher();
    stopPushTokenMaintenance();
    stopPostMetricsSweep();
    stopImageJobSweep();
    stopBrandVoiceExtractedSampleSweep();
    stopVideoJobSweep();
    stopFxRateSweep();
    stopTrueUpRetrySweep();
    stopWalletSettlementRetrySweep();
    stopWalletProviderRecovery();
    void shutdown(signal);
  });
}
