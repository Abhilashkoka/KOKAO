import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { globalLimiter } from "./middlewares/rateLimit";
import router from "./routes";
import { logger } from "./lib/logger";

/**
 * Origins allowed to make credentialed (cookie-authed) cross-origin requests.
 * Built from REPLIT_DOMAINS (comma-separated hostnames, no scheme). Requests
 * with no Origin header (same-origin navigations, curl, server-to-server) are
 * always allowed; any other origin is rejected rather than blindly reflected.
 */
const allowedOrigins = new Set(
  (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `https://${d}`),
);

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

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(helmet());

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // No Origin header => same-origin / non-browser client => allow.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);

app.use(globalLimiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
