import { Feather } from "@expo/vector-icons";
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

/** True when an API error is a 402 quota-exhausted response. */
export function isQuotaError(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 402;
}

export const QUOTA_FALLBACK_MESSAGE =
  "You have reached your monthly AI quota. Upgrade your plan on the web app to continue.";

/** Member-facing copy when they can ask the owner for an upgrade. */
export const QUOTA_MEMBER_ASK_OWNER_MESSAGE =
  "The workspace has run out of AI quota. Ask your workspace owner to upgrade.";

/** Member-facing copy when upgrade requests are disabled. */
export const QUOTA_MEMBER_PLAIN_MESSAGE = "The workspace is out of AI quota.";

/**
 * Message for a quota (402) error.
 *
 * Owners get the server's text (it tells them to upgrade or buy credits,
 * which they can actually do). Team members can't act on that advice, so
 * they get role-appropriate copy instead: "ask your owner" when upgrade
 * requests are enabled, or a plain out-of-quota notice when they're not.
 */
export function quotaErrorMessage(
  err: unknown,
  opts?: { isOwner?: boolean; upgradeRequestsEnabled?: boolean },
): string {
  if (opts?.isOwner === false) {
    return opts.upgradeRequestsEnabled
      ? QUOTA_MEMBER_ASK_OWNER_MESSAGE
      : QUOTA_MEMBER_PLAIN_MESSAGE;
  }
  const data = (err as { data?: { error?: string } | null } | null)?.data;
  return (typeof data?.error === "string" && data.error) || QUOTA_FALLBACK_MESSAGE;
}

/**
 * Tappable notice shown wherever an AI generation hit the monthly quota.
 * Tapping it opens the QuotaInfoSheet with the full explanation.
 */
export function QuotaErrorNotice({
  message,
  onPress,
}: {
  message: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Learn how AI quotas work and how to get more"
      style={({ pressed }) => [styles.noticeBox, { opacity: pressed ? 0.85 : 1 }]}
    >
      <Feather name="zap-off" size={16} color={c.accentForeground} />
      <View style={{ flex: 1 }}>
        <Text style={styles.noticeText}>{message}</Text>
        <Text style={styles.noticeLink}>Tap to see how quotas work and how to get more</Text>
      </View>
      <Feather name="chevron-right" size={16} color={c.accentForeground} />
    </Pressable>
  );
}

/**
 * Shared bottom sheet explaining AI generation quotas: monthly reset plus how
 * to get more right away (upgrade or credit packs, on the web app under
 * Settings > Billing). Reused by every screen that can hit a 402.
 */
export function QuotaInfoSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.header}>
            <Text style={styles.title}>About your AI quota</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Feather name="x" size={22} color={c.mutedForeground} />
            </Pressable>
          </View>

          <View style={styles.row}>
            <Feather name="refresh-cw" size={16} color={c.primary} style={styles.rowIcon} />
            <Text style={styles.rowText}>
              Your plan includes a monthly allowance of AI captions and images. It resets
              automatically at the start of each billing month, so you can generate again then
              at no extra cost.
            </Text>
          </View>

          <View style={styles.row}>
            <Feather name="zap" size={16} color={c.primary} style={styles.rowIcon} />
            <Text style={styles.rowText}>
              Need more right away? Upgrade your plan or buy a credit pack. Credits are used
              automatically once your monthly allowance runs out.
            </Text>
          </View>

          <View style={styles.row}>
            <Feather name="globe" size={16} color={c.primary} style={styles.rowIcon} />
            <Text style={styles.rowText}>
              Upgrades and credit packs are managed on the KOKAO web app: open Settings, then
              Billing.
            </Text>
          </View>

          <Button title="Got it" onPress={onClose} style={{ marginTop: 18 }} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  noticeBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 12,
    padding: 12,
    borderRadius: colors.radius,
    backgroundColor: c.accent,
  },
  noticeText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.accentForeground,
    lineHeight: 19,
  },
  noticeLink: {
    fontFamily: fonts.semiBold,
    fontSize: 12,
    color: c.accentForeground,
    marginTop: 6,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: c.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  title: { fontFamily: fonts.bold, fontSize: 17, color: c.foreground },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 14,
  },
  rowIcon: { marginTop: 2 },
  rowText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.foreground,
    lineHeight: 19,
  },
});
