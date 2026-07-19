/**
 * Consent-aware mobile analytics client.
 *
 * Mirrors the web tracker: events queue locally and flush in batches to the
 * public ingestion endpoint. The server enforces stored consent (it decides
 * what is kept); this client also respects the loaded consent state so
 * opted-out users don't even send gated data.
 *
 * Conventions (shared with web): snake_case event and parameter names,
 * anonymous_id merged into user_id at login, no raw PII in params.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import * as Battery from "expo-battery";
import * as Cellular from "expo-cellular";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Location from "expo-location";
import * as Network from "expo-network";
import { Platform } from "react-native";

const domain = process.env.EXPO_PUBLIC_DOMAIN;
const INGEST_URL = domain ? `https://${domain}/api/analytics/events` : null;

const ANON_KEY = "kokao_anon_id";
const FIRST_OPEN_KEY = "kokao_first_open";
const SIGN_UP_KEY = "kokao_sign_up_tracked";
/** How recently a Clerk user must have been created to count as a fresh sign-up. */
const SIGN_UP_FRESH_WINDOW_MS = 60 * 60_000;
const SESSION_TIMEOUT_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 15_000;
const MAX_QUEUE = 40;

export interface ConsentState {
  analytics: boolean;
  deviceDetails: boolean;
  locationCoarse: boolean;
  locationPrecise: boolean;
  carrier: boolean;
  responded: boolean;
}

interface QueuedEvent {
  name: string;
  params?: Record<string, unknown>;
  clientTimestamp: string;
}

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let signedIn = false;
let consent: ConsentState | null = null;
let anonymousId: string | null = null;
let sessionId: string | null = null;
let sessionLastActive = 0;
let authToken: (() => Promise<string | null>) | null = null;
let carrierName: string | null = null;
let networkType: string | null = null;
let position: { latitude: number; longitude: number } | null = null;
let currentScreen: string | null = null;
let previousScreen: string | null = null;
let startupTrackedAt: number | null = null;

function newId(): string {
  return Crypto.randomUUID();
}

async function getAnonymousId(): Promise<string> {
  if (anonymousId) return anonymousId;
  try {
    const stored = await AsyncStorage.getItem(ANON_KEY);
    if (stored) {
      anonymousId = stored;
      return stored;
    }
  } catch {
    // storage unavailable; fall through to an in-memory id
  }
  anonymousId = newId();
  try {
    await AsyncStorage.setItem(ANON_KEY, anonymousId);
  } catch {
    // best effort
  }
  return anonymousId;
}

function getSessionId(): { id: string; isNew: boolean } {
  const now = Date.now();
  if (sessionId && now - sessionLastActive < SESSION_TIMEOUT_MS) {
    sessionLastActive = now;
    return { id: sessionId, isNew: false };
  }
  sessionId = newId();
  sessionLastActive = now;
  return { id: sessionId, isNew: true };
}

function buildContext(): Record<string, unknown> {
  const allowDevice = !signedIn || consent === null || consent.deviceDetails;
  const allowCarrier = signedIn && consent?.carrier && carrierName;
  const allowPrecise = signedIn && consent?.locationPrecise && position;
  return {
    platform: Platform.OS === "ios" ? "ios" : "android",
    appVersion: Application.nativeApplicationVersion ?? "dev",
    language: undefined,
    ...(allowDevice
      ? {
          osVersion: `${Platform.OS} ${Device.osVersion ?? ""}`.trim(),
          deviceModel: Device.modelName ?? undefined,
          networkType: networkType ?? undefined,
        }
      : {}),
    ...(allowCarrier ? { carrier: carrierName } : {}),
    ...(allowPrecise ? position : {}),
  };
}

async function flush(): Promise<void> {
  if (queue.length === 0 || !INGEST_URL) return;
  if (signedIn && consent !== null && !consent.analytics) {
    queue = [];
    return;
  }
  const events = queue.splice(0, MAX_QUEUE);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = authToken ? await authToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    await fetch(INGEST_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        anonymousId: await getAnonymousId(),
        sessionId: getSessionId().id,
        context: buildContext(),
        events,
      }),
    });
  } catch {
    // Analytics must never break the app; drop the batch on failure.
  }
}

export function track(name: string, params?: Record<string, unknown>): void {
  if (signedIn && consent !== null && !consent.analytics) return;
  queue.push({ name, params, clientTimestamp: new Date().toISOString() });
  if (queue.length >= MAX_QUEUE) void flush();
}

/** Record a screen view with the previous screen for navigation paths. */
export function trackScreenView(screen: string): void {
  if (screen === currentScreen) return;
  previousScreen = currentScreen;
  currentScreen = screen;
  track("screen_view", {
    page: screen,
    ...(previousScreen ? { referrer_page: previousScreen } : {}),
  });
}

export function trackFeatureUse(feature: string, params?: Record<string, unknown>): void {
  track("feature_use", { feature, ...params });
}

/**
 * Fire "sign_up" exactly once per new user. Called after sign-in with the
 * Clerk user's id and creation time; only accounts created within the fresh
 * window count (so existing users signing in on a new device don't fire it).
 * Deduped in AsyncStorage by user id.
 *
 * The event is flushed IMMEDIATELY (not queued for the batch timer) and the
 * dedupe marker is only committed after the server accepts the delivery, so
 * killing the app right after first sign-in can't permanently lose the event:
 * on a failed send, the next launch retries.
 */
let signUpTrackedFor: string | null = null;

export async function trackSignUpOnce(
  userId: string,
  createdAt: Date | null | undefined,
): Promise<void> {
  if (!userId || !createdAt) return;
  if (Date.now() - createdAt.getTime() > SIGN_UP_FRESH_WINDOW_MS) return;
  if (signUpTrackedFor === userId) return;
  try {
    if ((await AsyncStorage.getItem(SIGN_UP_KEY)) === userId) return;
  } catch {
    // storage unavailable; the in-memory marker still dedupes this session
  }
  if (signedIn && consent !== null && !consent.analytics) return;
  if (!INGEST_URL) return;
  // In-memory guard prevents concurrent double-fires while the send is in flight.
  signUpTrackedFor = userId;
  let delivered = false;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = authToken ? await authToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        anonymousId: await getAnonymousId(),
        sessionId: getSessionId().id,
        context: buildContext(),
        events: [
          {
            name: "sign_up",
            params: { method: "clerk" },
            clientTimestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    delivered = res.ok;
  } catch {
    delivered = false;
  }
  if (delivered) {
    // Commit the dedupe marker only once the server accepted the batch.
    try {
      await AsyncStorage.setItem(SIGN_UP_KEY, userId);
    } catch {
      // best effort; the in-memory marker still dedupes this session
    }
  } else {
    // Allow a retry on a later call (e.g. the next launch).
    signUpTrackedFor = null;
  }
}

export function trackError(errorType: string, screen?: string, fatal = false): void {
  track(fatal ? "app_crash" : "error_occurred", {
    error_type: errorType.slice(0, 120),
    screen: screen ?? currentScreen ?? "unknown",
    fatal: String(fatal),
  });
}

/** Provide a Clerk token getter so batches are attributed to the user. */
export function setAnalyticsAuth(getToken: (() => Promise<string | null>) | null): void {
  authToken = getToken;
}

/** Called once the signed-in user's stored consent is loaded. */
export function setConsentState(state: ConsentState | null, isSignedIn: boolean): void {
  consent = state;
  signedIn = isSignedIn;
  if (isSignedIn && state && !state.analytics) {
    queue = [];
    return;
  }
  if (isSignedIn && state?.analytics) {
    if (state.carrier && carrierName === null) {
      void Cellular.getCarrierNameAsync()
        .then((name) => {
          carrierName = name ?? null;
        })
        .catch(() => {
          carrierName = null;
        });
    }
    // Coarse location is derived server-side from the request (geo-IP);
    // device GPS is only used for the explicit precise-location opt-in.
    if (state.locationPrecise && position === null) {
      void (async () => {
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== "granted") return;
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          position = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          };
        } catch {
          position = null;
        }
      })();
    }
  }
}

/** Initialize: first-open/session events, startup timing, telemetry probes. */
export function initAnalytics(appStartedAt: number): void {
  if (flushTimer) return;

  void (async () => {
    try {
      const firstOpen = await AsyncStorage.getItem(FIRST_OPEN_KEY);
      if (!firstOpen) {
        await AsyncStorage.setItem(FIRST_OPEN_KEY, new Date().toISOString());
        track("first_open", {});
      }
    } catch {
      // best effort
    }
  })();

  if (getSessionId().isNew) {
    track("session_start", {});
  }

  if (startupTrackedAt === null) {
    startupTrackedAt = Date.now();
    track("app_startup", {
      duration_ms: Math.max(0, startupTrackedAt - appStartedAt),
      startup_type: "cold",
    });
  }

  void Network.getNetworkStateAsync()
    .then((state) => {
      networkType = state.type ? String(state.type).toLowerCase() : null;
    })
    .catch(() => {
      networkType = null;
    });

  void Battery.getBatteryLevelAsync()
    .then((level) => {
      if (level >= 0) {
        track("battery_sample", { battery_pct: Math.round(level * 100) });
      }
    })
    .catch(() => {
      // battery info unavailable (e.g. web/simulator)
    });

  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}
