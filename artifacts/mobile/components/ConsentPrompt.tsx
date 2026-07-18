import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import {
  useGetConsent,
  getGetConsentQueryKey,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const ackKey = (userId: string) => `kokao-consent-prompt-${userId}`;

/**
 * One-time privacy prompt for signed-in users who have never responded to the
 * consent question (GET /consent returns responded: false). Reviewing routes
 * to the Privacy & Data screen; dismissing is remembered per user in
 * AsyncStorage so the prompt never repeats and never blocks usage.
 */
export function ConsentPrompt() {
  const router = useRouter();
  const { userId } = useAuth();
  const consentQuery = useGetConsent({
    query: { queryKey: getGetConsentQueryKey() },
  });
  const [open, setOpen] = useState(false);

  const responded = consentQuery.data?.responded;

  useEffect(() => {
    if (!userId || responded !== false) return;
    let cancelled = false;
    AsyncStorage.getItem(ackKey(userId))
      .then((seen) => {
        if (!cancelled && !seen) setOpen(true);
      })
      .catch(() => {
        // Storage unavailable — skip the prompt rather than loop it.
      });
    return () => {
      cancelled = true;
    };
  }, [userId, responded]);

  if (!open) return null;

  const markSeen = () => {
    setOpen(false);
    if (userId) {
      AsyncStorage.setItem(ackKey(userId), "1").catch(() => {
        // Ignore storage failures; worst case the prompt shows again.
      });
    }
  };

  const review = () => {
    markSeen();
    router.push("/privacy");
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={markSeen}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.titleRow}>
            <Feather name="shield" size={20} color={c.primary} />
            <Text style={styles.title}>Your privacy choices</Text>
          </View>
          <Text style={styles.body}>
            KOKAO can collect optional usage data to help improve the app.
            Everything is off by default and nothing is collected until you say
            so. You can review the choices now or change them anytime from the
            shield icon on Home.
          </Text>
          <Button title="Review choices" onPress={review} style={{ marginTop: 18 }} />
          <Pressable
            onPress={markSeen}
            accessibilityLabel="Not now"
            style={({ pressed }) => [styles.laterBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.laterText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    backgroundColor: c.card,
    borderRadius: 16,
    padding: 22,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 17,
    color: c.foreground,
    flex: 1,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: c.mutedForeground,
    marginTop: 12,
  },
  laterBtn: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 8,
  },
  laterText: {
    fontFamily: fonts.semiBold,
    fontSize: 14,
    color: c.mutedForeground,
  },
});
