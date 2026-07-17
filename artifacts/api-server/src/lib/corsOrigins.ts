/**
 * Origins allowed to make credentialed (cookie-authed) cross-origin requests.
 *
 * Built from REPLIT_DOMAINS (comma-separated hostnames, no scheme) plus
 * REPLIT_EXPO_DEV_DOMAIN: the Expo dev server (mobile app on web) runs on its
 * own domain that is NOT included in REPLIT_DOMAINS and calls the API
 * cross-origin with a bearer token. Dropping it silently breaks the mobile
 * app in dev (server returns 200, browser discards the response).
 *
 * Also includes REPLIT_INTERNAL_APP_DOMAIN when set: the mobile production
 * build (artifacts/mobile/scripts/build.js) prefers this var as the app's
 * public domain, and it is not guaranteed to be listed in REPLIT_DOMAINS.
 * If it differed and were missing here, the published mobile app's requests
 * would be silently dropped by the browser (200 with no CORS headers).
 *
 * Entries may arrive with or without a scheme (REPLIT_INTERNAL_APP_DOMAIN
 * can include one), so any leading http(s):// is stripped before the origin
 * is normalized to https://<host>.
 *
 * Kept as a pure function so tests can assert the allowlist contents without
 * importing the full app (which pulls in Clerk, DB, routes, etc.).
 */
export function buildAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  return new Set(
    [
      ...(env.REPLIT_DOMAINS ?? "").split(","),
      env.REPLIT_EXPO_DEV_DOMAIN ?? "",
      env.REPLIT_INTERNAL_APP_DOMAIN ?? "",
    ]
      .map((d) => d.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""))
      .filter(Boolean)
      .map((d) => `https://${d}`),
  );
}
