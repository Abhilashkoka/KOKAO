import { useSSO } from "@clerk/expo";
import { FontAwesome } from "@expo/vector-icons";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

WebBrowser.maybeCompleteAuthSession();

type Provider = {
  strategy: "oauth_google" | "oauth_apple";
  label: string;
  icon: React.ReactNode;
};

const PROVIDERS: Provider[] = [
  {
    strategy: "oauth_google",
    label: "Continue with Google",
    icon: <FontAwesome name="google" size={18} color={c.foreground} />,
  },
  {
    strategy: "oauth_apple",
    label: "Continue with Apple",
    icon: <FontAwesome name="apple" size={20} color={c.foreground} />,
  },
];

export function SocialSignInButtons({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const { startSSOFlow } = useSSO();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  const handlePress = useCallback(
    async (strategy: Provider["strategy"]) => {
      if (pending) return;
      setPending(strategy);
      try {
        const { createdSessionId, setActive } = await startSSOFlow({
          strategy,
          redirectUrl: AuthSession.makeRedirectUri(),
        });
        if (createdSessionId && setActive) {
          await setActive({
            session: createdSessionId,
            navigate: () => {
              router.replace("/(tabs)");
            },
          });
        } else {
          onError(
            "We couldn't finish signing you in with that account. Please try again or use email and password.",
          );
        }
      } catch {
        onError(
          "Sign-in was cancelled or failed. Please try again or use email and password.",
        );
      } finally {
        setPending(null);
      }
    },
    [pending, startSSOFlow, router, onError],
  );

  return (
    <View>
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or continue with</Text>
        <View style={styles.dividerLine} />
      </View>
      {PROVIDERS.map((provider) => (
        <Pressable
          key={provider.strategy}
          style={({ pressed }) => [
            styles.socialButton,
            pressed && styles.socialButtonPressed,
          ]}
          disabled={pending !== null}
          onPress={() => handlePress(provider.strategy)}
        >
          {pending === provider.strategy ? (
            <ActivityIndicator size="small" color={c.foreground} />
          ) : (
            <>
              <View style={styles.iconBox}>{provider.icon}</View>
              <Text style={styles.socialButtonText}>{provider.label}</Text>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 24,
    marginBottom: 14,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: c.border },
  dividerText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    marginHorizontal: 10,
  },
  socialButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingVertical: 12,
    marginBottom: 10,
    backgroundColor: c.card,
  },
  socialButtonPressed: { opacity: 0.7 },
  iconBox: { width: 26, alignItems: "center", marginRight: 8 },
  socialButtonText: {
    fontFamily: fonts.semiBold,
    fontSize: 15,
    color: c.foreground,
  },
});
