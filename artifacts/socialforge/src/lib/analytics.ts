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
const UTM_KEY = "kokao_utm";
const SESSION_TIMEOUT_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 10_000;
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

async function flush(useBeacon = false): Promise<void> {
  if (queue.length === 0) return;
  // Signed-in users who declined analytics send nothing at all.
  if (signedIn && consent !== null && !consent.analytics) {
    queue = [];
    return;
  }
  const events = queue.splice(0, MAX_QUEUE);
  const body = JSON.stringify({
    anonymousId: getAnonymousId(),
    sessionId: getSession().id,
    context: buildContext(),
    events,
  });
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(INGEST_URL, new Blob([body], { type: "application/json" }));
      return;
    }
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body,
    });
  } catch {
    // Analytics must never break the app; drop the batch on failure.
  }
}

/** Queue an event. Flushes automatically on a timer and page hide. */
export function track(name: string, params?: Record<string, unknown>): void {
  if (signedIn && consent !== null && !consent.analytics) return;
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

export function trackFeatureUse(feature: string, params?: Record<string, unknown>): void {
  track("feature_use", { feature, ...params });
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
  consent = state;
  signedIn = isSignedIn;
  if (isSignedIn && state && !state.analytics) {
    queue = [];
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
    if (document.visibilityState === "hidden") void flush(true);
  });

  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}
