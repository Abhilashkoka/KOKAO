import express, { type Express } from "express";
import { requireTenant } from "../middlewares/requireTenant";
import credentialsRouter from "../routes/credentials";
import metaRouter from "../routes/meta";
import linkedinRouter, { linkedinCallbackRouter } from "../routes/linkedin";
import twitterRouter, { twitterCallbackRouter } from "../routes/twitter";
import threadsRouter, { threadsCallbackRouter } from "../routes/threads";
import youtubeRouter, { youtubeCallbackRouter } from "../routes/youtube";
import adminRouter from "../routes/admin";
import emailSettingsRouter from "../routes/emailSettings";
import { protectedAppBrandRouter } from "../routes/appBrand";
import notificationsRouter from "../routes/notifications";
import notificationSettingsRouter from "../routes/notificationSettings";
import pushTokensRouter from "../routes/pushTokens";
import meRouter from "../routes/me";
import teamRouter from "../routes/team";
import contentRouter from "../routes/content";
import metricsRouter from "../routes/metrics";
import campaignsRouter from "../routes/campaigns";

function attachLogStub(app: Express): void {
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
}

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
  attachLogStub(app);
  // OAuth callbacks are PUBLIC in routes/index.ts (mounted before the tenant
  // gate) because the provider redirects the browser without a session; the
  // signed state carries the tenant binding. Mirror that ordering here.
  app.use(
    "/api",
    linkedinCallbackRouter,
    twitterCallbackRouter,
    threadsCallbackRouter,
    youtubeCallbackRouter,
  );
  app.use(
    "/api",
    requireTenant,
    credentialsRouter,
    metaRouter,
    linkedinRouter,
    twitterRouter,
    threadsRouter,
    youtubeRouter,
    notificationsRouter,
    notificationSettingsRouter,
    pushTokensRouter,
    meRouter,
    teamRouter,
    contentRouter,
    metricsRouter,
    campaignsRouter,
  );
  return app;
}

/**
 * Build a minimal Express app that mounts the real tenant gate plus the admin
 * router under `/api`, matching the auth ordering in `routes/index.ts`
 * (requireTenant first, then the protected admin router — whose own
 * `requireSuperadmin` gate then runs for every `/admin/*` route).
 *
 * `@clerk/express` must be mocked by the importing test file before this runs.
 */
export function createAdminTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  attachLogStub(app);
  app.use(
    "/api",
    requireTenant,
    adminRouter,
    emailSettingsRouter,
    protectedAppBrandRouter,
    credentialsRouter,
  );
  return app;
}
