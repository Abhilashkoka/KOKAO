import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@clerk/react";
import {
  useSessionTimeoutGetSettings,
  getSessionTimeoutGetSettingsQueryKey,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * App-wide inactivity auto-logout.
 *
 * When enabled by the superadmin, an idle user is warned with an in-app
 * countdown dialog and then signed out. Activity is shared across tabs through
 * localStorage so working in one tab keeps the others alive.
 *
 * Native browser dialogs (window.confirm) are blocked inside the preview
 * iframe, so the warning is a Radix AlertDialog.
 */

// Shared across tabs: writing here fires a `storage` event in the others.
export const LAST_ACTIVITY_KEY = "kokao:lastActivityAt";
// Read by the signed-out screen to explain why the session ended.
export const INACTIVITY_SIGNOUT_FLAG = "kokao:signedOutForInactivity";

// Record activity at most this often — the listeners fire on every mousemove.
const ACTIVITY_THROTTLE_MS = 5_000;
// How often we re-evaluate idle time and tick the countdown.
const TICK_MS = 1_000;

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
];

function now(): number {
  return Date.now();
}

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : now();
  } catch {
    return now();
  }
}

function writeLastActivity(ts: number): void {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(ts));
  } catch {
    // Private mode / storage disabled: activity simply won't sync across tabs.
  }
}

export function useIdleLogout() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  // Only fetch the settings once the user is actually signed in.
  const { data: settings } = useSessionTimeoutGetSettings({
    query: {
      enabled: Boolean(isLoaded && isSignedIn),
      queryKey: getSessionTimeoutGetSettingsQueryKey(),
      // An already-open tab must adopt admin changes without a reload: poll
      // ~once a minute and refetch on focus so new thresholds take effect
      // within about a minute of being saved.
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });

  const enabled = Boolean(isSignedIn && settings?.enabled);
  const timeoutMs = (settings?.timeoutMinutes ?? 0) * 60 * 1000;
  const warningMs = (settings?.warningSeconds ?? 0) * 1000;
  const warnAtMs = Math.max(timeoutMs - warningMs, 0);

  const [warningOpen, setWarningOpen] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  // Latch so we call signOut only once per idle incident.
  const signedOutRef = useRef(false);
  const lastWriteRef = useRef(0);

  const recordActivity = useCallback(() => {
    const ts = now();
    // Throttle writes; every mousemove would otherwise hammer localStorage.
    if (ts - lastWriteRef.current < ACTIVITY_THROTTLE_MS) return;
    lastWriteRef.current = ts;
    writeLastActivity(ts);
  }, []);

  const staySignedIn = useCallback(() => {
    const ts = now();
    lastWriteRef.current = ts;
    writeLastActivity(ts);
    setWarningOpen(false);
  }, []);

  // Seed a fresh activity timestamp whenever monitoring turns on.
  useEffect(() => {
    if (!enabled) {
      setWarningOpen(false);
      signedOutRef.current = false;
      return;
    }
    const ts = now();
    lastWriteRef.current = ts;
    writeLastActivity(ts);
    signedOutRef.current = false;
  }, [enabled]);

  // Activity listeners + cross-tab sync.
  useEffect(() => {
    if (!enabled) return;

    const onActivity = () => recordActivity();
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    const onStorage = (e: StorageEvent) => {
      // Another tab recorded activity: close our warning too.
      if (e.key === LAST_ACTIVITY_KEY) {
        setWarningOpen(false);
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
      window.removeEventListener("storage", onStorage);
    };
  }, [enabled, recordActivity]);

  // The idle clock.
  useEffect(() => {
    if (!enabled) return;

    const check = () => {
      const last = readLastActivity();
      // Guard against clock jumps / future timestamps producing negative idle.
      const idleMs = Math.max(now() - last, 0);

      if (idleMs >= timeoutMs) {
        if (!signedOutRef.current) {
          signedOutRef.current = true;
          setWarningOpen(false);
          try {
            sessionStorage.setItem(INACTIVITY_SIGNOUT_FLAG, "1");
          } catch {
            // ignore
          }
          void signOut();
        }
        return;
      }

      if (idleMs >= warnAtMs) {
        setWarningOpen(true);
        // Ceil so the countdown starts at the full warning window.
        setRemainingSeconds(Math.max(Math.ceil((timeoutMs - idleMs) / 1000), 0));
      } else {
        setWarningOpen(false);
      }
    };

    check();
    const id = window.setInterval(check, TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled, timeoutMs, warnAtMs, signOut]);

  return {
    warningOpen,
    remainingSeconds,
    staySignedIn,
  };
}

export function IdleLogoutWarning() {
  const { warningOpen, remainingSeconds, staySignedIn } = useIdleLogout();

  return (
    <AlertDialog open={warningOpen}>
      <AlertDialogContent data-testid="idle-logout-warning">
        <AlertDialogHeader>
          <AlertDialogTitle>Still there?</AlertDialogTitle>
          <AlertDialogDescription>
            You will be signed out in{" "}
            <span className="font-semibold text-foreground" data-testid="idle-countdown">
              {remainingSeconds}
            </span>{" "}
            second{remainingSeconds === 1 ? "" : "s"} due to inactivity.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={staySignedIn}
            data-testid="button-stay-signed-in"
          >
            Stay signed in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
