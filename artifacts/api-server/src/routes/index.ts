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
import videosRouter from "./videos";
import imageJobsRouter from "./imageJobs";
import charactersRouter from "./characters";
import videoStylesRouter from "./videoStyles";
import assetsRouter from "./assets";
import googleDriveRouter, { googleDriveCallbackRouter } from "./googleDrive";
import gamificationRouter from "./gamification";
import schedulesRouter from "./schedules";
import accountsRouter from "./accounts";
import metaRouter from "./meta";
import twitterRouter, { twitterCallbackRouter } from "./twitter";
import credentialsRouter from "./credentials";
import linkedinRouter, { linkedinCallbackRouter } from "./linkedin";
import youtubeRouter, { youtubeCallbackRouter } from "./youtube";
import threadsRouter, { threadsCallbackRouter } from "./threads";
import adsRouter, { adsCallbackRouter } from "./ads";
import notificationsRouter from "./notifications";
import notificationSettingsRouter from "./notificationSettings";
import pushTokensRouter from "./pushTokens";
import aiSpendRouter from "./aiSpend";
import tasteProfileRouter from "./tasteProfile";
import emailSettingsRouter from "./emailSettings";
import billingRouter from "./billing";
import walletRouter from "./wallet";
import razorpayWebhookRouter from "./razorpayWebhook";
import cashfreeWebhookRouter from "./cashfreeWebhook";
import adminRouter from "./admin";
import consentRouter from "./consent";
import analyticsIngestRouter from "./analyticsIngest";
import analyticsRouter from "./analytics";
import healthReportRouter from "./healthReport";
import { publicAppBrandRouter, protectedAppBrandRouter } from "./appBrand";
import featuresRouter from "./features";
import metricsRouter from "./metrics";
import campaignsRouter from "./campaigns";
import sessionTimeoutRouter from "./sessionTimeout";
import { requireTenant } from "../middlewares/requireTenant";
import { aiLimiter, sensitiveLimiter } from "../middlewares/rateLimit";
import { requireFeature, requireAnyFeature } from "../lib/featureFlags";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use(publicStorageRouter);
router.use(plansRouter);
router.use(publicAppBrandRouter);
// Razorpay webhook: server-to-server, authenticated by its HMAC signature
// (no app session), so it must sit before requireTenant.
router.use(razorpayWebhookRouter);
// Cashfree webhook: same rationale as Razorpay — HMAC-authenticated,
// server-to-server, must sit before requireTenant.
router.use(cashfreeWebhookRouter);
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
router.use("/google-drive", sensitiveLimiter);
router.use("/ads/meta/auth", sensitiveLimiter);
router.use(twitterCallbackRouter);
router.use(linkedinCallbackRouter);
router.use(youtubeCallbackRouter);
router.use(googleDriveCallbackRouter);
router.use(threadsCallbackRouter);
router.use(adsCallbackRouter);

// Everything below requires an authenticated tenant
router.use(requireTenant);

// Tight rate-limit buckets on the expensive / third-party-calling routes
// (AI generation, credential verification, and OAuth). Mounted before their
// routers so they run first for matching paths.
router.use("/ai", aiLimiter);
router.use("/social-credentials", sensitiveLimiter);

// Platform-wide feature kill switches (superadmin-controlled): when a module
// is disabled, its routes answer 403 feature_disabled for every tenant. The
// admin router below is deliberately NOT gated so switches can be re-enabled.
router.use("/ai", requireFeature("aiStudio"));
router.use("/ai/generate-carousel", requireFeature("carousel"));
// Video Studio: its own kill switch on top of the /ai gate; the Google Drive
// import exists solely for it, so it shares the switch.
router.use("/ai/generate-video", requireFeature("videoGen"));
router.use("/ai/video-jobs", requireFeature("videoGen"));
// Reference styles: own kill switch on top of the video studio gate.
router.use("/ai/video-styles", requireFeature("videoGen"));
router.use("/ai/video-styles", requireFeature("referenceStyles"));
// Async image jobs: own kill switch on top of the /ai gate; when off, the
// studio falls back to the synchronous generate-image route.
// Viral toolkit: hook writer + platform pack, own switch on top of /ai.
router.use("/ai/generate-hooks", requireFeature("viralToolkit"));
router.use("/ai/platform-pack", requireFeature("viralToolkit"));
router.use("/ai/generate-image-async", requireFeature("imageJobs"));
router.use("/ai/image-jobs", requireFeature("imageJobs"));
router.use("/google-drive", requireFeature("videoGen"));
// Characters exist for the Video Studio, so they share its kill switch.
router.use("/characters", requireFeature("videoGen"));
router.use("/visual-assets", requireFeature("assetLibrary"));
router.use("/content", requireFeature("contentLibrary"));
router.use("/schedules", requireFeature("scheduling"));
router.use("/brand-kits", requireFeature("brandKits"));
router.use("/brand-preferences", requireFeature("brandKits"));
router.use("/onboarding", requireFeature("brandKits"));
router.use("/accounts", requireFeature("connectedAccounts"));
router.use("/social-credentials", requireFeature("connectedAccounts"));
router.use("/meta", requireFeature("connectedAccounts"));
router.use("/twitter", requireFeature("connectedAccounts"));
router.use("/linkedin", requireFeature("connectedAccounts"));
router.use("/youtube", requireFeature("connectedAccounts"));
router.use("/threads", requireFeature("connectedAccounts"));
router.use("/analytics", requireFeature("analytics"));
router.use("/team", requireFeature("team"));
router.use("/billing", requireFeature("billing"));
// Promo redemption gets its own switch on top of billing's, plus the tight
// rate-limit bucket so codes can't be brute-forced.
router.use("/billing/promo", sensitiveLimiter, requireFeature("promoCodes"));
// Upgrade requests get their own switch on top of billing's, plus the tight
// rate-limit bucket since it triggers owner emails.
router.use(
  "/billing/request-upgrade",
  sensitiveLimiter,
  requireFeature("upgradeRequests"),
);
// Prepaid rupee wallet: its own switch, and a tight rate-limit bucket since
// top-ups create Razorpay orders.
router.use("/wallet", requireFeature("wallet"));
router.use("/wallet/recharge", sensitiveLimiter);
router.use("/wallet/verify-recharge", sensitiveLimiter);
router.use("/push-tokens", requireFeature("pushNotifications"));
router.use("/ai-spend", requireFeature("aiSpend"));
router.use("/metrics", requireFeature("postMetrics"));
router.use("/campaigns", requireFeature("campaigns"));

router.use(protectedStorageRouter);
router.use(featuresRouter);
router.use(meRouter);
router.use(teamRouter);
router.use(brandKitsRouter);
router.use(brandPreferencesRouter);
router.use(onboardingRouter);
router.use("/gamification/referral", requireFeature("referrals"));
router.use(
  "/gamification",
  requireAnyFeature("quests", "streaks", "referrals", "progressMeter"),
);
// Claims grant credits: give them the tight rate-limit bucket.
router.use("/gamification/claim", sensitiveLimiter);

router.use(contentRouter);
router.use(metricsRouter);
router.use(campaignsRouter);
router.use(aiRouter);
router.use(imageJobsRouter);
router.use(videosRouter);
router.use(charactersRouter);
router.use(videoStylesRouter);
router.use(assetsRouter);
router.use(googleDriveRouter);
router.use(gamificationRouter);
router.use(schedulesRouter);
router.use(accountsRouter);
router.use(metaRouter);
router.use(twitterRouter);
router.use(credentialsRouter);
router.use(linkedinRouter);
router.use(youtubeRouter);
router.use(threadsRouter);
router.use(adsRouter);
router.use(notificationsRouter);
router.use(notificationSettingsRouter);
router.use(pushTokensRouter);
router.use(aiSpendRouter);
router.use(tasteProfileRouter);
router.use(emailSettingsRouter);
router.use(billingRouter);
router.use(walletRouter);
router.use(adminRouter);
router.use(sessionTimeoutRouter);
router.use(protectedAppBrandRouter);
router.use(consentRouter);
router.use(analyticsRouter);
router.use(healthReportRouter);

export default router;
