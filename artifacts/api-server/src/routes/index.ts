import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { publicStorageRouter, protectedStorageRouter } from "./storage";
import plansRouter from "./plans";
import meRouter from "./me";
import brandKitsRouter from "./brandKits";
import brandPreferencesRouter from "./brandPreferences";
import onboardingRouter from "./onboarding";
import contentRouter from "./content";
import aiRouter from "./ai";
import schedulesRouter from "./schedules";
import accountsRouter from "./accounts";
import metaRouter from "./meta";
import twitterRouter, { twitterCallbackRouter } from "./twitter";
import credentialsRouter from "./credentials";
import linkedinRouter, { linkedinCallbackRouter } from "./linkedin";
import youtubeRouter, { youtubeCallbackRouter } from "./youtube";
import notificationsRouter from "./notifications";
import notificationSettingsRouter from "./notificationSettings";
import emailSettingsRouter from "./emailSettings";
import adminRouter from "./admin";
import { publicAppBrandRouter, protectedAppBrandRouter } from "./appBrand";
import { requireTenant } from "../middlewares/requireTenant";
import { aiLimiter, sensitiveLimiter } from "../middlewares/rateLimit";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use(publicStorageRouter);
router.use(plansRouter);
router.use(publicAppBrandRouter);
// OAuth callbacks arrive as top-level redirects from the provider and may not
// carry the app session; they authenticate via the HMAC-signed `state` token
// instead. Rate-limited like the other OAuth/credential routes.
router.use("/twitter", sensitiveLimiter);
router.use("/linkedin", sensitiveLimiter);
router.use("/youtube", sensitiveLimiter);
router.use(twitterCallbackRouter);
router.use(linkedinCallbackRouter);
router.use(youtubeCallbackRouter);

// Everything below requires an authenticated tenant
router.use(requireTenant);

// Tight rate-limit buckets on the expensive / third-party-calling routes
// (AI generation, credential verification, and OAuth). Mounted before their
// routers so they run first for matching paths.
router.use("/ai", aiLimiter);
router.use("/social-credentials", sensitiveLimiter);

router.use(protectedStorageRouter);
router.use(meRouter);
router.use(brandKitsRouter);
router.use(brandPreferencesRouter);
router.use(onboardingRouter);
router.use(contentRouter);
router.use(aiRouter);
router.use(schedulesRouter);
router.use(accountsRouter);
router.use(metaRouter);
router.use(twitterRouter);
router.use(credentialsRouter);
router.use(linkedinRouter);
router.use(youtubeRouter);
router.use(notificationsRouter);
router.use(notificationSettingsRouter);
router.use(emailSettingsRouter);
router.use(adminRouter);
router.use(protectedAppBrandRouter);

export default router;
