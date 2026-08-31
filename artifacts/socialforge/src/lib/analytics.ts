/**
 * Consent-aware web analytics client.
 *
 * Events are queued locally and flushed in batches to the public ingestion
 * endpoint. The server is the enforcement point (stored consent decides what
 * is kept), but this client also respects the loaded consent state so that
 * opted-out users don't even send gated data.
 *
 * Conventions (shared with mobile): snake_case event and parameter names,
 * anonymous_id merged into user_id at login, no raw PII in params.
 */

const BASE = import.meta.env.BASE_URL; // ends with "/"
const INGEST_URL = `${BASE}api/analytics/events`;

const ANON_KEY = "kokao_anon_id";
const SESSION_KEY = "kokao_session";
const FIRST_OPEN_KEY = "kokao_first_open";
const SIGN_UP_KEY = "kokao_sign_up_tracked";
/** How recently a Clerk user must have been created to count as a fresh sign-up. */
const SIGN_UP_FRESH_WINDOW_MS = 60 * 60_000;
const UTM_KEY = "kokao_utm";
/** localStorage key holding unsent events so they survive tab closes mid-outage. */
const PENDING_KEY = "kokao_pending_events";
const SESSION_TIMEOUT_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_QUEUE = 40;
/** Max times a batch's events are re-queued after a failed send before being dropped. */
const MAX_SEND_ATTEMPTS = 3;
/** Hard cap on buffered events (including re-queued ones); oldest are dropped beyond this. */
const MAX_BUFFERED = 120;

type ProjectAnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: ProjectAnalyticsData): void;
    };
  }
}

/**
 * Replit-hosted project analytics is injected only in published web builds.
 * Keep it separate from the consent-aware product analytics queue, and always
 * fail closed so a missing or broken tracker cannot affect user actions.
 */
export function trackProjectEvent(
  name: string,
  data?: ProjectAnalyticsData,
): void {
  if (typeof window === "undefined") return;
  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}

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
let precisePosition: { latitude: number; longitude: number } | null = null;
let currentPage: string | null = null;
let previousPage: string | null = null;

function safeStorage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function getAnonymousId(): string {
  const store = safeStorage("local");
  let id = store?.getItem(ANON_KEY) ?? null;
  if (!id) {
    id = crypto.randomUUID();
    store?.setItem(ANON_KEY, id);
  }
  return id;
}

interface SessionInfo {
  id: string;
  lastActive: number;
  isNew: boolean;
}

function getSession(): SessionInfo {
  const store = safeStorage("session");
  const now = Date.now();
  try {
    const raw = store?.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id: string; lastActive: number };
      if (now - parsed.lastActive < SESSION_TIMEOUT_MS) {
        const refreshed = { id: parsed.id, lastActive: now };
        store?.setItem(SESSION_KEY, JSON.stringify(refreshed));
        return { ...refreshed, isNew: false };
      }
    }
  } catch {
    // fall through to a new session
  }
  const fresh = { id: crypto.randomUUID(), lastActive: now };
  store?.setItem(SESSION_KEY, JSON.stringify(fresh));
  return { ...fresh, isNew: true };
}

/** UTM parameters captured once per session (first touch wins). */
function captureUtm(): { source?: string; medium?: string; campaign?: string } {
  const store = safeStorage("session");
  try {
    const existing = store?.getItem(UTM_KEY);
    if (existing) return JSON.parse(existing) as Record<string, string>;
  } catch {
    // ignore
  }
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  const source = params.get("utm_source");
  const medium = params.get("utm_medium");
  const campaign = params.get("utm_campaign");
  if (source) utm.source = source.slice(0, 120);
  if (medium) utm.medium = medium.slice(0, 60);
  if (campaign) utm.campaign = campaign.slice(0, 120);
  if (Object.keys(utm).length > 0) {
    store?.setItem(UTM_KEY, JSON.stringify(utm));
  }
  return utm;
}

function browserInfo(): string {
  const ua = navigator.userAgent;
  const rules: [string, RegExp][] = [
    ["Edge", /Edg\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/],
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of rules) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]!.split(".")[0]}`;
  }
  return "Other";
}

function osInfo(): string {
  const ua = navigator.userAgent;
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

function networkType(): string | undefined {
  const conn = (navigator as { connection?: { effectiveType?: string } }).connection;
  return conn?.effectiveType;
}

function buildContext(): Record<string, unknown> {
  const utm = captureUtm();
  const allowDevice = !signedIn || consent === null || consent.deviceDetails;
  const allowPrecise = signedIn && consent?.locationPrecise && precisePosition;
  return {
    platform: "web",
    appVersion: import.meta.env.VITE_APP_VERSION ?? "web",
    language: navigator.language,
    ...(allowDevice
      ? {
          browser: browserInfo(),
          osVersion: osInfo(),
          networkType: networkType(),
        }
      : {}),
    ...(allowPrecise ? precisePosition : {}),
    ...utm,
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
 * Mirror the in-memory queue into localStorage so unsent events survive the
 * tab being closed while the network is down. Called after every flush and
 * on page hide; an empty queue clears the stored copy.
 */
function persistQueue(): void {
  const store = safeStorage("local");
  if (!store) return;
  try {
    if (queue.length === 0) {
      store.removeItem(PENDING_KEY);
    } else {
      store.setItem(PENDING_KEY, JSON.stringify(queue.slice(-MAX_BUFFERED)));
    }
  } catch {
    // storage full/unavailable; analytics must never break the app
  }
}

/**
 * Restore events persisted by a previous page load. The stored copy is
 * removed immediately so a crashy init can't replay it twice; the existing
 * caps still apply (over-attempted events are dropped, buffer capped at
 * MAX_BUFFERED with newest events winning).
 */
function restoreQueue(): void {
  const store = safeStorage("local");
  if (!store) return;
  try {
    const raw = store.getItem(PENDING_KEY);
    store.removeItem(PENDING_KEY);
    if (!raw) return;
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

async function flush(useBeacon = false): Promise<void> {
  if (queue.length === 0) {
    persistQueue();
    return;
  }
  // Signed-in users whose consent decision is still UNRESOLVED (not yet
  // loaded, or the dialog is still open) must not flush: the server would
  // answer 200 with accepted:0 and the batch would be silently lost — e.g.
  // onboarding_started when the consent dialog stays open past one flush
  // interval. Hold (and persist) the queue until the decision lands.
  if (signedIn && (consent === null || !consent.responded)) {
    persistQueue();
    return;
  }
  // Signed-in users who explicitly declined analytics send nothing at all.
  if (signedIn && consent !== null && !consent.analytics) {
    queue = [];
    persistQueue();
    return;
  }
  const batch = queue.splice(0, MAX_QUEUE);
  const body = JSON.stringify({
    anonymousId: getAnonymousId(),
    sessionId: getSession().id,
    context: buildContext(),
    // Strip the internal retry counter from the wire payload.
    events: batch.map(({ attempts: _attempts, ...event }) => event),
  });
  try {
    if (useBeacon && navigator.sendBeacon) {
      const accepted = navigator.sendBeacon(
        INGEST_URL,
        new Blob([body], { type: "application/json" }),
      );
      if (!accepted) requeueFailedBatch(batch);
      persistQueue();
      return;
    }
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body,
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
  persistQueue();
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
};

/** Queue an event. Flushes automatically on a timer and page hide. */
export function track(name: string, params?: Record<string, unknown>): void {
  // Only an explicit opt-out drops events; an unresolved decision queues
  // them (flush holds the batch until consent lands).
  if (signedIn && consent !== null && consent.responded && !consent.analytics) return;
  queue.push({
    name,
    params,
    clientTimestamp: new Date().toISOString(),
  });
  if (queue.length >= MAX_QUEUE) void flush();
}

/** Record a page view with the previous page for navigation-path analysis. */
export function trackPageView(page: string): void {
  if (page === currentPage) return;
  previousPage = currentPage;
  currentPage = page;
  track("page_view", {
    page,
    ...(previousPage ? { referrer_page: previousPage } : {}),
  });
}

/**
 * Fire "sign_up" exactly once per new user. Called after sign-in with the
 * Clerk user's id and creation time; only accounts created within the fresh
 * window count (so existing users signing in on a new device don't fire it).
 * Deduped in localStorage by user id.
 *
 * The event is flushed IMMEDIATELY (not queued for the batch timer) and the
 * dedupe marker is only committed after the server accepts the delivery, so
 * closing the tab right after first sign-in can't permanently lose the event:
 * on a failed send, the next visit retries.
 */
let signUpTrackedFor: string | null = null;
/** Bounded per-page-load auto-retries after an unacknowledged send. */
let signUpAutoRetries = 0;
const SIGN_UP_MAX_AUTO_RETRIES = 3;

export function trackSignUpOnce(userId: string, createdAt: Date | null | undefined): void {
  if (!userId || !createdAt) return;
  if (Date.now() - createdAt.getTime() > SIGN_UP_FRESH_WINDOW_MS) return;
  if (signUpTrackedFor === userId) return;
  const store = safeStorage("local");
  if (store?.getItem(SIGN_UP_KEY) === userId) return;
  if (signedIn && consent !== null && !consent.analytics) return;
  // In-memory guard prevents concurrent double-fires while the send is in flight.
  signUpTrackedFor = userId;
  void (async () => {
    let delivered = false;
    try {
      const res = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: JSON.stringify({
          anonymousId: getAnonymousId(),
          sessionId: getSession().id,
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
      if (res.ok) {
        // The ingest endpoint answers 200 even when server-side consent
        // drops the whole batch ({accepted: 0}). Only a genuinely stored
        // event may commit the dedupe marker — otherwise a sign_up sent
        // before the user answered the consent dialog would be lost forever.
        // A missing/malformed body is treated as NOT delivered (retry later);
        // never assume storage without positive acknowledgement.
        const body = (await res.json().catch(() => null)) as {
          accepted?: unknown;
        } | null;
        delivered =
          body !== null &&
          typeof body.accepted === "number" &&
          body.accepted > 0;
      }
    } catch {
      delivered = false;
    }
    if (delivered) {
      // Commit the dedupe marker only once the server accepted the batch.
      store?.setItem(SIGN_UP_KEY, userId);
    } else {
      // Allow a retry on a later call (e.g. the next visit).
      signUpTrackedFor = null;
      // In-flight race guard: if consent flipped to analytics: true WHILE
      // this pre-consent attempt was pending, the consent-driven caller
      // already ran and bailed on the in-memory guard — no further state
      // change would ever trigger another attempt. Retry here (bounded)
      // now that the current in-memory consent permits analytics.
      if (
        signedIn &&
        consent?.analytics &&
        signUpAutoRetries < SIGN_UP_MAX_AUTO_RETRIES
      ) {
        signUpAutoRetries += 1;
        trackSignUpOnce(userId, createdAt);
      }
    }
  })();
}

export function trackFeatureUse(feature: string, params?: Record<string, unknown>): void {
  track("feature_use", { feature, ...params });
}

/**
 * Ready-made cast funnel:
 * preset_character_selected -> preset_outfit_approved (optional) -> preset_video_enqueued.
 *
 * Keep this helper intentionally narrow: the stable preset ID is the only
 * dimension permitted for these events. Never add prompts, outfit text,
 * tenant identifiers, or other user-provided values.
 */
export function trackPresetCastEvent(
  name: "preset_character_selected" | "preset_outfit_approved" | "preset_video_enqueued",
  presetId: string,
): void {
  if (!presetId) return;
  track(name, { preset_id: presetId });
}

/**
 * Privacy-safe protected-outfit funnel events. Keep the dimensions coarse:
 * never add character/outfit identifiers, names, descriptions, or image paths.
 */
export function trackProtectedOutfitEvent(
  name:
    | "protected_outfit_editor_opened"
    | "protected_outfit_preview_generated"
    | "protected_outfit_preview_approved"
    | "protected_outfit_preview_rejected",
  source: "preset" | "tenant",
  entryLocation: "video_studio_character_manager",
): void {
  try {
    track(name, {
      source,
      entry_location: entryLocation,
    });
  } catch {
    // Analytics must never affect outfit generation or review actions.
  }
}

export function trackError(errorType: string, screen?: string, fatal = false): void {
  track("error_occurred", {
    error_type: errorType.slice(0, 120),
    screen: screen ?? currentPage ?? "unknown",
    fatal: String(fatal),
  });
}

/** Called by the app once the signed-in user's stored consent is loaded. */
export function setConsentState(state: ConsentState | null, isSignedIn: boolean): void {
  const hadPending = queue.length > 0;
  consent = state;
  signedIn = isSignedIn;
  // Only an explicit opt-out wipes held events; an unresolved decision
  // (responded: false) keeps them queued until the user chooses.
  if (isSignedIn && state && state.responded && !state.analytics) {
    queue = [];
    persistQueue();
  }
  // Opt-in: push any events held while the decision was pending.
  if (isSignedIn && state?.responded && state.analytics && hadPending) {
    void flush();
  }
  // Precise location: only request the browser permission when the user has
  // explicitly opted in to precise location AND analytics.
  if (isSignedIn && state?.analytics && state.locationPrecise && !precisePosition) {
    try {
      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          precisePosition = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          };
        },
        () => {
          precisePosition = null;
        },
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
      );
    } catch {
      precisePosition = null;
    }
  }
}

/** Initialize the tracker: session/lifecycle events, flush loop, error hooks. */
export function initAnalytics(): void {
  if (flushTimer) return; // already initialized
  const store = safeStorage("local");
  const session = getSession();

  // Recover events a previous page load couldn't send (e.g. the tab was
  // closed while the network was down).
  restoreQueue();

  if (store && !store.getItem(FIRST_OPEN_KEY)) {
    store.setItem(FIRST_OPEN_KEY, new Date().toISOString());
    track("first_open", { page: window.location.pathname });
  }
  if (session.isNew) {
    track("session_start", {});
  }

  // Page-load timing (web "startup").
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav && nav.loadEventEnd > 0) {
      track("app_startup", {
        duration_ms: Math.round(nav.loadEventEnd - nav.startTime),
        startup_type: "cold",
      });
    }
  } catch {
    // unsupported browser; skip
  }

  window.addEventListener("error", (e) => {
    trackError(e.error?.name ?? "window_error");
  });
  window.addEventListener("unhandledrejection", () => {
    trackError("unhandled_rejection");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // The beacon path is synchronous up to the requeue, so the persist
      // below captures whatever couldn't be handed off before a tab close.
      void flush(true);
      persistQueue();
    }
  });
  window.addEventListener("pagehide", () => {
    void flush(true);
    persistQueue();
  });

  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}
