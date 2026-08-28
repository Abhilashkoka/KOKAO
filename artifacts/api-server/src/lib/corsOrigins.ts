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
 * is normalized to https://<host>. Hostnames are lowercased: published
 * domains can be configured with capital letters (e.g.
 * SMP-builder-....replit.app) but browsers always send a lowercase Origin
 * header, so a case-preserving allowlist would silently reject the app's
 * own production origin.
 *
 * In development, browser automation may serve Expo web from a loopback HTTP
 * origin on an ephemeral port. Those origins cannot be enumerated up front, so
 * isAllowedOrigin permits only localhost/127.0.0.1 over HTTP in development.
 *
 * Kept as pure functions so tests can assert the policy without importing the
 * full app (which pulls in Clerk, DB, routes, etc.).
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
      .map((d) =>
        d.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase(),
      )
      .filter(Boolean)
      .map((d) => `https://${d}`),
  );
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!origin || allowedOrigins.has(origin)) return true;
  if (env.NODE_ENV !== "development") return false;

  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}
