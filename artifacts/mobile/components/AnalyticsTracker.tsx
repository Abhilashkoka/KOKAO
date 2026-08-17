import { useAuth, useUser } from "@clerk/expo";
import { usePathname } from "expo-router";
import { useEffect } from "react";
import { useGetConsent, getGetConsentQueryKey } from "@workspace/api-client-react";

import {
  initAnalytics,
  setAnalyticsAuth,
  setConsentState,
  trackScreenView,
  trackSignUpOnce,
  type ConsentState,
} from "@/lib/analytics";

const APP_STARTED_AT = Date.now();

/** Headless component: wires consent, auth, and screen tracking together. */
export function AnalyticsTracker() {
  const pathname = usePathname();
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const { data: consent } = useGetConsent({
    query: {
      queryKey: getGetConsentQueryKey(),
      enabled: Boolean(isSignedIn),
      staleTime: 60_000,
    },
  });

  useEffect(() => {
    initAnalytics(APP_STARTED_AT);
  }, []);

  useEffect(() => {
    setAnalyticsAuth(isSignedIn ? () => getToken() : null);
  }, [isSignedIn, getToken]);

  useEffect(() => {
    setConsentState((consent as ConsentState | undefined) ?? null, Boolean(isSignedIn));
  }, [consent, isSignedIn]);

  // Re-attempt after consent changes: if the initial send returned accepted:0
  // (server-side consent not yet stored), the marker is left unset so this
  // effect retries as soon as the user grants analytics consent. trackSignUpOnce
  // internally dedupes via both in-memory guard and AsyncStorage, so the only
  // re-send that lands is the one that actually gets accepted.
  const analyticsConsented = (consent as ConsentState | undefined)?.analytics ?? null;
  useEffect(() => {
    if (isSignedIn && user) {
      void trackSignUpOnce(user.id, user.createdAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, user, analyticsConsented]);

  useEffect(() => {
    if (pathname) trackScreenView(pathname);
  }, [pathname]);

  return null;
}
