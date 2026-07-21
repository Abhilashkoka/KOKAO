import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  useFonts,
} from "@expo-google-fonts/plus-jakarta-sans";
import { ClerkProvider, ClerkLoaded, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl, setAuthTokenGetter, ApiError } from "@workspace/api-client-react";

import { AnalyticsTracker } from "@/components/AnalyticsTracker";
import { PushRegistrar } from "@/lib/pushNotifications";
import { trackError } from "@/lib/analytics";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { fonts } from "@/constants/fonts";
import colors from "@/constants/colors";

const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // On a cold open (deep link from a push notification) the very first
      // request can race Clerk's token hydration and come back 401 even
      // though the user is signed in. Retry those instead of surfacing an
      // error card; other 4xx errors are terminal.
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 401) return failureCount < 3;
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 2;
      },
    },
  },
});

/**
 * Registers the Clerk token getter with the API client synchronously during
 * render, so it is in place before any child screen mounts and fires its
 * first query (important for cold opens that deep-link straight into an
 * authed screen like the notifications inbox).
 */
function ApiAuthBridge({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  setAuthTokenGetter(() => getToken());
  return <>{children}</>;
}

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerTitleStyle: { fontFamily: fonts.semiBold },
        headerTintColor: colors.light.primary,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="content/[id]" options={{ title: "Edit Content" }} />
      <Stack.Screen name="privacy" options={{ title: "Privacy & Data" }} />
      <Stack.Screen name="settings" options={{ title: "Plan & Billing" }} />
      <Stack.Screen name="ads" options={{ title: "Ads" }} />
      <Stack.Screen
        name="notifications"
        options={{ title: "Notifications" }}
      />
      <Stack.Screen
        name="notification-settings"
        options={{ title: "Notification Settings" }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      tokenCache={tokenCache}
      proxyUrl={proxyUrl}
    >
      <ClerkLoaded>
        <SafeAreaProvider>
          <ErrorBoundary
            onError={(error) => trackError(error.name || "render_error", undefined, true)}
          >
            <QueryClientProvider client={queryClient}>
              <AnalyticsTracker />
              <PushRegistrar />
              <GestureHandlerRootView>
                <KeyboardProvider>
                  <ApiAuthBridge>
                    <RootLayoutNav />
                  </ApiAuthBridge>
                </KeyboardProvider>
              </GestureHandlerRootView>
            </QueryClientProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
