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
import facebookRouter from "./facebook";
import linkedinRouter from "./linkedin";
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
router.use(facebookRouter);
router.use(linkedinRouter);
router.use(adminRouter);

export default router;
