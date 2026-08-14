import { useEffect } from "react";
import { useLocation } from "wouter";
import { useUser } from "@clerk/react";
import {
  useGetConsent,
  getGetConsentQueryKey,
} from "@workspace/api-client-react";
import {
  initAnalytics,
  setConsentState,
  trackPageView,
  trackSignUpOnce,
} from "@/lib/analytics";

/**
 * Headless component: initializes the analytics client, keeps the tracker's
 * consent state in sync with the signed-in user's stored consent, and records
 * page views on every navigation. Renders nothing.
 */
export function AnalyticsTracker() {
  const [location] = useLocation();
  const { isSignedIn, user } = useUser();
  const { data: consent } = useGetConsent({
    query: {
      queryKey: getGetConsentQueryKey(),
      enabled: Boolean(isSignedIn),
      staleTime: 60_000,
    },
  });

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    setConsentState(
      consent
        ? {
            analytics: consent.analytics,
            deviceDetails: consent.deviceDetails,
            locationCoarse: consent.locationCoarse,
            locationPrecise: consent.locationPrecise,
            carrier: consent.carrier,
            responded: consent.responded,
          }
        : null,
      Boolean(isSignedIn),
    );
  }, [consent, isSignedIn]);

  // `consent` is a deliberate dependency: a brand-new user's first attempt
  // runs before they answer the consent dialog, so the server drops it and
  // no marker is committed. Once the stored consent loads (or flips to
  // analytics: true in the onboarding wizard), this re-fires and the
  // internal dedupe ensures at most one delivered sign_up.
  useEffect(() => {
    if (isSignedIn && user) {
      trackSignUpOnce(user.id, user.createdAt);
    }
  }, [isSignedIn, user, consent]);

  useEffect(() => {
    trackPageView(location);
  }, [location]);

  return null;
}
