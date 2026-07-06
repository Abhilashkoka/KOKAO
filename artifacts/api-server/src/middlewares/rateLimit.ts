import rateLimit from "express-rate-limit";

/**
 * Rate limiters. Keyed by client IP (requires `trust proxy` so `req.ip` is the
 * real caller behind the Replit/Cloud Run edge, set in app.ts). Skipped under
 * the test runner so suites that fire many requests from 127.0.0.1 don't trip
 * a 429.
 */
const MINUTE = 60_000;

const skip = () => process.env.NODE_ENV === "test";

const common = {
  windowMs: MINUTE,
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  skip,
};

/** Coarse safety net across the whole API. */
export const globalLimiter = rateLimit({
  ...common,
  limit: 300,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

/** Tight bucket for the expensive, outbound-calling AI endpoints. */
export const aiLimiter = rateLimit({
  ...common,
  limit: 30,
  message: { error: "Too many AI requests. Please wait a moment and try again." },
});

/**
 * Tight bucket for credential-verify and OAuth routes, each of which calls out
 * to a third party (Meta / X / LinkedIn) and so carries cost-abuse and
 * reputation risk.
 */
export const sensitiveLimiter = rateLimit({
  ...common,
  limit: 20,
  message: { error: "Too many requests to this endpoint. Please wait and try again." },
});
