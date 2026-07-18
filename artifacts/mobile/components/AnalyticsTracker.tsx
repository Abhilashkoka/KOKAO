import { useAuth } from "@clerk/expo";
import { usePathname } from "expo-router";
import { useEffect } from "react";
import { useGetConsent, getGetConsentQueryKey } from "@workspace/api-client-react";

import {
  initAnalytics,
  setAnalyticsAuth,
  setConsentState,
  trackScreenView,
  type ConsentState,
} from "@/lib/analytics";

const APP_STARTED_AT = Date.now();

/** Headless component: wires consent, auth, and screen tracking together. */
export function AnalyticsTracker() {
  const pathname = usePathname();
  const { isSignedIn, getToken } = useAuth();
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

  useEffect(() => {
    if (pathname) trackScreenView(pathname);
  }, [pathname]);

  return null;
}
