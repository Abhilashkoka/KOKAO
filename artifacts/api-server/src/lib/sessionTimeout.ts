import { db, sessionTimeoutSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * App-wide inactivity auto-logout configuration.
 *
 * A single superadmin-managed row in session_timeout_settings drives the web
 * app's idle sign-out. When no row exists the built-in defaults apply so an
 * existing install keeps working untouched (enabled, 30-minute timeout with a
 * 60-second warning countdown).
 *
 * Cached briefly (like the payment-gateway cache) so the many signed-in clients
 * polling for the setting don't hit the DB on every request; the cache is
 * invalidated whenever the setting is saved.
 */
export interface SessionTimeoutSettings {
  enabled: boolean;
  timeoutMinutes: number;
  warningSeconds: number;
}

const DEFAULT_SETTINGS: SessionTimeoutSettings = {
  enabled: true,
  timeoutMinutes: 30,
  warningSeconds: 60,
};

const CACHE_TTL_MS = 30_000;

let cache: { settings: SessionTimeoutSettings; expiresAt: number } | null = null;

export function invalidateSessionTimeoutCache(): void {
  cache = null;
}

/**
 * The current settings. Falls back to the built-in defaults if the row is
 * missing or the lookup fails — a broken settings read must never lock users
 * out or take down the app.
 */
export async function getSessionTimeoutSettings(): Promise<SessionTimeoutSettings> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.settings;

  let settings: SessionTimeoutSettings = DEFAULT_SETTINGS;
  try {
    // The singleton always lives at id=1 (enforced by the fixed-id upsert in
    // saveSessionTimeoutSettings), so read it deterministically by id rather
    // than an arbitrary limit(1) row.
    const [row] = await db
      .select()
      .from(sessionTimeoutSettingsTable)
      .where(eq(sessionTimeoutSettingsTable.id, 1))
      .limit(1);
    if (row) {
      settings = {
        enabled: row.enabled,
        timeoutMinutes: row.timeoutMinutes,
        warningSeconds: row.warningSeconds,
      };
    }
  } catch (error) {
    logger.error(
      { err: error },
      "Failed to read session_timeout_settings; defaulting to built-in values",
    );
    // Do NOT cache the degraded result so a recovered DB is picked up at once.
    return DEFAULT_SETTINGS;
  }

  cache = { settings, expiresAt: now + CACHE_TTL_MS };
  return settings;
}

/**
 * Persist the settings (singleton row) and invalidate the cache. Uses a
 * fixed-id (id=1) upsert so concurrent first saves can never create more than
 * one row — the second racer conflicts on the primary key and updates the same
 * row instead of inserting a duplicate.
 */
export async function saveSessionTimeoutSettings(
  input: SessionTimeoutSettings,
): Promise<SessionTimeoutSettings> {
  const fields = {
    enabled: input.enabled,
    timeoutMinutes: input.timeoutMinutes,
    warningSeconds: input.warningSeconds,
    updatedAt: new Date(),
  };
  await db
    .insert(sessionTimeoutSettingsTable)
    .values({ id: 1, ...fields })
    .onConflictDoUpdate({
      target: sessionTimeoutSettingsTable.id,
      set: fields,
    });
  invalidateSessionTimeoutCache();
  return getSessionTimeoutSettings();
}
