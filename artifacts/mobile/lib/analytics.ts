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
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";

const domain = process.env.EXPO_PUBLIC_DOMAIN;
const INGEST_URL = domain ? `https://${domain}/api/analytics/events` : null;

const ANON_KEY = "kokao_anon_id";
const FIRST_OPEN_KEY = "kokao_first_open";
const SIGN_UP_KEY = "kokao_sign_up_tracked";
/** How recently a Clerk user must have been created to count as a fresh sign-up. */
const SIGN_UP_FRESH_WINDOW_MS = 60 * 60_000;
/** AsyncStorage key holding unsent events so they survive app kills mid-outage. */
const PENDING_KEY = "kokao_pending_events";
const SESSION_TIMEOUT_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 15_000;
const MAX_QUEUE = 40;
/** Max times a batch's events are re-queued after a failed send before being dropped. */
const MAX_SEND_ATTEMPTS = 3;
/** Hard cap on buffered events (including re-queued ones); oldest are dropped beyond this. */
const MAX_BUFFERED = 120;

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
  /** Failed-send count; internal only, stripped before sending. */
  attempts?: number;
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

/**
 * Put a failed batch back at the front of the queue so a later flush retries
 * it. Each event carries a bounded attempt count (dropped after
 * MAX_SEND_ATTEMPTS failed sends) so an ambiguous failure — where the request
 * actually landed server-side — can only duplicate a bounded number of times.
 * The total buffer is capped at MAX_BUFFERED; newest events win.
 */
function requeueFailedBatch(events: QueuedEvent[]): void {
  const retryable = events
    .map((e) => ({ ...e, attempts: (e.attempts ?? 0) + 1 }))
    .filter((e) => e.attempts < MAX_SEND_ATTEMPTS);
  queue = [...retryable, ...queue];
  if (queue.length > MAX_BUFFERED) {
    queue = queue.slice(queue.length - MAX_BUFFERED);
  }
}

/**
 * Mirror the in-memory queue into AsyncStorage so unsent events survive the
 * app being killed while the network is down. Called after every flush; an
 * empty queue clears the stored copy.
 */
async function persistQueue(): Promise<void> {
  try {
    if (queue.length === 0) {
      await AsyncStorage.removeItem(PENDING_KEY);
    } else {
      await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(queue.slice(-MAX_BUFFERED)));
    }
  } catch {
    // storage unavailable; analytics must never break the app
  }
}

/**
 * Restore events persisted by a previous launch. The stored copy is removed
 * immediately so a crashy init can't replay it twice; the existing caps
 * still apply (over-attempted events are dropped, buffer capped at
 * MAX_BUFFERED with newest events winning).
 */
async function restoreQueue(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(PENDING_KEY);
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {
    // storage unavailable
    return;
  }
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const restored = (parsed as QueuedEvent[]).filter(
      (e) =>
        e !== null &&
        typeof e === "object" &&
        typeof e.name === "string" &&
        typeof e.clientTimestamp === "string" &&
        (e.attempts ?? 0) < MAX_SEND_ATTEMPTS,
    );
    queue = [...restored, ...queue];
    if (queue.length > MAX_BUFFERED) {
      queue = queue.slice(queue.length - MAX_BUFFERED);
    }
  } catch {
    // corrupt stored copy; start fresh
  }
}

async function flush(): Promise<void> {
  if (queue.length === 0 || !INGEST_URL) {
    if (INGEST_URL) await persistQueue();
    return;
  }
  if (signedIn && consent !== null && !consent.analytics) {
    queue = [];
    await persistQueue();
    return;
  }
  const batch = queue.splice(0, MAX_QUEUE);
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
        // Strip the internal retry counter from the wire payload.
        events: batch.map(({ attempts: _attempts, ...event }) => event),
      }),
    });
    // Retry server-side/transient failures; 4xx responses mean the payload
    // was rejected and retrying would never succeed.
    if (!res.ok && (res.status >= 500 || res.status === 429)) {
      requeueFailedBatch(batch);
    }
  } catch {
    // Analytics must never break the app; re-queue the batch (bounded) so a
    // brief network blip doesn't permanently lose the events.
    requeueFailedBatch(batch);
  }
  await persistQueue();
}

/** Test-only access to the internal queue and flush (not for app code). */
export const __analyticsTestHooks = {
  flush,
  getQueue: (): readonly QueuedEvent[] => queue,
  setQueue: (events: QueuedEvent[]): void => {
    queue = events;
  },
  resetQueue: (): void => {
    queue = [];
  },
  persistQueue,
  restoreQueue,
  handleAppStateChange: (nextState: AppStateStatus): void => handleAppStateChange(nextState),
};

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

/**
 * Fire "first_open" exactly once per install. Like sign_up, the event is
 * sent IMMEDIATELY and the AsyncStorage marker is only committed after the
 * server accepts the delivery — an offline/failed first launch retries on
 * the next launch instead of being lost forever. An in-memory guard dedupes
 * concurrent sends within a session.
 */
let firstOpenInFlight = false;

async function trackFirstOpenOnce(): Promise<void> {
  if (firstOpenInFlight) return;
  try {
    if (await AsyncStorage.getItem(FIRST_OPEN_KEY)) return;
  } catch {
    // Storage unavailable: we can't tell whether first_open was already
    // reported, so skip rather than risk duplicates on every launch.
    return;
  }
  if (signedIn && consent !== null && !consent.analytics) return;
  if (!INGEST_URL) return;
  firstOpenInFlight = true;
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
          { name: "first_open", params: {}, clientTimestamp: new Date().toISOString() },
        ],
      }),
    });
    delivered = res.ok;
  } catch {
    delivered = false;
  }
  if (delivered) {
    // Commit the marker only once the server accepted the event.
    try {
      await AsyncStorage.setItem(FIRST_OPEN_KEY, new Date().toISOString());
    } catch {
      // best effort; the in-flight guard still dedupes this session
    }
  } else {
    // Allow the next launch (or a later init) to retry.
    firstOpenInFlight = false;
  }
}

/**
 * When the app leaves the foreground the OS may kill it before the next
 * 15-second flush tick, losing any events tracked since the last flush.
 * Flush immediately and then persist whatever the flush couldn't send so
 * the events survive an app kill. Never throws — analytics must never
 * break the app.
 *
 * Returning to the foreground ("active") also triggers an immediate flush:
 * connectivity is likely restored, so buffered/restored events shouldn't
 * wait up to 15 seconds for the next interval tick. The existing attempt
 * caps in flush() prevent duplicate sends.
 */
function handleAppStateChange(nextState: AppStateStatus): void {
  if (nextState === "active") {
    void flush();
    return;
  }
  if (nextState !== "background" && nextState !== "inactive") return;
  void (async () => {
    try {
      await flush();
    } catch {
      // flush already swallows its own errors; belt and suspenders
    }
    try {
      await persistQueue();
    } catch {
      // storage unavailable; best effort
    }
  })();
}

/** Initialize: first-open/session events, startup timing, telemetry probes. */
export function initAnalytics(appStartedAt: number): void {
  if (flushTimer) return;

  // Persist the freshest events the moment the app is backgrounded, since
  // the OS can kill it before the next interval flush.
  try {
    AppState.addEventListener("change", handleAppStateChange);
  } catch {
    // AppState unavailable (e.g. web/test); interval flushes still persist
  }

  // Recover events a previous launch couldn't send (e.g. the app was killed
  // while the network was down).
  void restoreQueue();

  void trackFirstOpenOnce();

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
