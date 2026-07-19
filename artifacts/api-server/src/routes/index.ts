import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { publicStorageRouter, protectedStorageRouter } from "./storage";
import plansRouter from "./plans";
import meRouter from "./me";
import teamRouter from "./team";
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
import threadsRouter, { threadsCallbackRouter } from "./threads";
import notificationsRouter from "./notifications";
import notificationSettingsRouter from "./notificationSettings";
import tasteProfileRouter from "./tasteProfile";
import emailSettingsRouter from "./emailSettings";
import billingRouter from "./billing";
import razorpayWebhookRouter from "./razorpayWebhook";
import adminRouter from "./admin";
import consentRouter from "./consent";
import analyticsIngestRouter from "./analyticsIngest";
import analyticsRouter from "./analytics";
import healthReportRouter from "./healthReport";
import { publicAppBrandRouter, protectedAppBrandRouter } from "./appBrand";
import { requireTenant } from "../middlewares/requireTenant";
import { aiLimiter, sensitiveLimiter } from "../middlewares/rateLimit";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use(publicStorageRouter);
router.use(plansRouter);
router.use(publicAppBrandRouter);
// Razorpay webhook: server-to-server, authenticated by its HMAC signature
// (no app session), so it must sit before requireTenant.
router.use(razorpayWebhookRouter);
// Analytics ingestion: PUBLIC so pre-login pages can record core lifecycle
// events under an anonymous id. Consent and event allowlists are enforced
// inside the route, server-side.
router.use(analyticsIngestRouter);
// OAuth callbacks arrive as top-level redirects from the provider and may not
// carry the app session; they authenticate via the HMAC-signed `state` token
// instead. Rate-limited like the other OAuth/credential routes.
router.use("/twitter", sensitiveLimiter);
router.use("/linkedin", sensitiveLimiter);
router.use("/youtube", sensitiveLimiter);
router.use("/threads", sensitiveLimiter);
router.use(twitterCallbackRouter);
router.use(linkedinCallbackRouter);
router.use(youtubeCallbackRouter);
router.use(threadsCallbackRouter);

// Everything below requires an authenticated tenant
router.use(requireTenant);

// Tight rate-limit buckets on the expensive / third-party-calling routes
// (AI generation, credential verification, and OAuth). Mounted before their
// routers so they run first for matching paths.
router.use("/ai", aiLimiter);
router.use("/social-credentials", sensitiveLimiter);

router.use(protectedStorageRouter);
router.use(meRouter);
router.use(teamRouter);
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
router.use(threadsRouter);
router.use(notificationsRouter);
router.use(notificationSettingsRouter);
router.use(tasteProfileRouter);
router.use(emailSettingsRouter);
router.use(billingRouter);
router.use(adminRouter);
router.use(protectedAppBrandRouter);
router.use(consentRouter);
router.use(analyticsRouter);
router.use(healthReportRouter);

export default router;
