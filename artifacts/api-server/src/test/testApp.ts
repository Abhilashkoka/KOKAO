import express, { type Express } from "express";
import { requireTenant } from "../middlewares/requireTenant";
import credentialsRouter from "../routes/credentials";
import metaRouter from "../routes/meta";
import linkedinRouter from "../routes/linkedin";

/**
 * Build a minimal Express app that mounts the real tenant gate plus the
 * credential and publish routers under `/api`, exactly matching the auth
 * ordering in `routes/index.ts` (requireTenant first, then protected routers).
 *
 * `@clerk/express` must be mocked by the importing test file before this runs.
 */
export function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // pino-http normally attaches req.log; stub it so route handlers can log.
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use(
    "/api",
    requireTenant,
    credentialsRouter,
    metaRouter,
    linkedinRouter,
  );
  return app;
}
