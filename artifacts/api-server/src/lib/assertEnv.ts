import { logger } from "./logger";

/**
 * Environment variables that MUST be present when running in a deployed
 * (production) context. Several subsystems degrade silently if these are
 * missing — the Clerk auth proxy no-ops without CLERK_SECRET_KEY, credential
 * encryption and OAuth-state signing depend on SESSION_SECRET, and object
 * storage throws only on first use. Rather than boot into a subtly broken
 * state, fail loudly at startup.
 */
const REQUIRED_PROD_ENV = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "PUBLIC_OBJECT_SEARCH_PATHS",
  "PRIVATE_OBJECT_DIR",
] as const;

/**
 * Assert the required environment is present before the server starts serving.
 * No-op outside production so local/dev runs (which use Clerk dev instances and
 * may not set every var) aren't blocked.
 */
export function assertRequiredEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing = REQUIRED_PROD_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    const message =
      `Refusing to start: missing required environment variable(s) in ` +
      `production: ${missing.join(", ")}. Set them in the deployment ` +
      `configuration and redeploy.`;
    logger.fatal({ missing }, message);
    throw new Error(message);
  }
}
