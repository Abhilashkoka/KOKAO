import type { NextFunction, Request, Response } from "express";
import { beginTrackedRequest, isShuttingDown } from "../lib/backgroundJobs";

const RESTARTING_MESSAGE =
  "The server is restarting. Your post was not published — please try again in a moment.";

/**
 * Guard for SYNCHRONOUS publish routes (Facebook, Instagram, LinkedIn,
 * Threads, X) that perform the platform write inside the HTTP request.
 *
 * Two protections:
 * 1. If graceful shutdown has already begun, reject with a retriable 503
 *    BEFORE any platform write starts, so a post can't land on the platform
 *    while the process dies before persisting the DB status.
 * 2. Otherwise, register the request in the shutdown drain (the same pending
 *    set background jobs use) so an in-flight publish is awaited by the
 *    drain loop instead of being killed mid-request when SIGTERM fires.
 *
 * The tracking entry is released when the response finishes or the
 * connection closes, whichever comes first.
 */
export function trackSyncPublish(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isShuttingDown()) {
    res.status(503).json({ error: RESTARTING_MESSAGE });
    return;
  }
  const done = beginTrackedRequest();
  if (!done) {
    // Shutdown began between the check above and registration.
    res.status(503).json({ error: RESTARTING_MESSAGE });
    return;
  }
  res.on("finish", done);
  res.on("close", done);
  next();
}
