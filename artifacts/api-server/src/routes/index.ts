import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { publicStorageRouter, protectedStorageRouter } from "./storage";
import plansRouter from "./plans";
import meRouter from "./me";
import brandKitsRouter from "./brandKits";
import contentRouter from "./content";
import aiRouter from "./ai";
import schedulesRouter from "./schedules";
import accountsRouter from "./accounts";
import metaRouter from "./meta";
import twitterRouter from "./twitter";
import credentialsRouter from "./credentials";
import linkedinRouter from "./linkedin";
import notificationsRouter from "./notifications";
import adminRouter from "./admin";
import { requireTenant } from "../middlewares/requireTenant";

const router: IRouter = Router();

// Public routes
router.use(healthRouter);
router.use(publicStorageRouter);
router.use(plansRouter);

// Everything below requires an authenticated tenant
router.use(requireTenant);
router.use(protectedStorageRouter);
router.use(meRouter);
router.use(brandKitsRouter);
router.use(contentRouter);
router.use(aiRouter);
router.use(schedulesRouter);
router.use(accountsRouter);
router.use(metaRouter);
router.use(twitterRouter);
router.use(credentialsRouter);
router.use(linkedinRouter);
router.use(notificationsRouter);
router.use(adminRouter);

export default router;
