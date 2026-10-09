import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { globalLimiter } from "./middlewares/rateLimit";
import router from "./routes";
import { logger } from "./lib/logger";
import { buildAllowedOrigins, isAllowedOrigin } from "./lib/corsOrigins";
import { apiLatencySampler } from "./middlewares/apiLatency";
import { complianceErrorHandler } from "./middlewares/complianceErrors";

/**
 * Origins allowed to make credentialed (cookie-authed) cross-origin requests.
 * Built from REPLIT_DOMAINS + REPLIT_EXPO_DEV_DOMAIN (see lib/corsOrigins.ts).
 * Requests with no Origin header (same-origin navigations, curl,
 * server-to-server) are always allowed; any other origin is rejected rather
 * than blindly reflected.
 */
const allowedOrigins = buildAllowedOrigins();

const app: Express = express();

// The app runs behind the Replit/Cloud Run edge (one trusted proxy hop). Trust
// it so `req.ip` reflects the real client for rate limiting and logging.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(helmet());

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // No Origin header => same-origin / non-browser client => allow.
      if (isAllowedOrigin(origin, allowedOrigins)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);

app.use(globalLimiter);
// Keep the raw request body around for webhook signature verification
// (Razorpay signs the exact bytes it sent; re-serializing parsed JSON is
// not guaranteed to match).
app.use(
  express.json({
    verify(req, _res, buf) {
      (req as { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware({
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  }),
);

app.use(apiLatencySampler);
app.use("/api", router);
// Compliance errors thrown from any route become a clear JSON answer.
app.use("/api", complianceErrorHandler);

export default app;
