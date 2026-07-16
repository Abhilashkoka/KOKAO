/**
 * Origins allowed to make credentialed (cookie-authed) cross-origin requests.
 *
 * Built from REPLIT_DOMAINS (comma-separated hostnames, no scheme) plus
 * REPLIT_EXPO_DEV_DOMAIN: the Expo dev server (mobile app on web) runs on its
 * own domain that is NOT included in REPLIT_DOMAINS and calls the API
 * cross-origin with a bearer token. Dropping it silently breaks the mobile
 * app in dev (server returns 200, browser discards the response).
 *
 * Kept as a pure function so tests can assert the allowlist contents without
 * importing the full app (which pulls in Clerk, DB, routes, etc.).
 */
export function buildAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  return new Set(
    [...(env.REPLIT_DOMAINS ?? "").split(","), env.REPLIT_EXPO_DEV_DOMAIN ?? ""]
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => `https://${d}`),
  );
}
