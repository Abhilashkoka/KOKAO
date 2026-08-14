import { Feather } from "@expo/vector-icons";
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getWalletGetOverviewQueryKey,
  useWalletGetOverview,
} from "@workspace/api-client-react";

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

/** Owner-facing fallback for wallet-billed workspaces (no plan upgrades to point at). */
export const QUOTA_OWNER_WALLET_MESSAGE =
  "You've reached your monthly AI limit. Recharge your prepaid wallet on the web app to keep generating.";

/** Member-facing copy when they can ask the owner for an upgrade. */
export const QUOTA_MEMBER_ASK_OWNER_MESSAGE =
  "The workspace has run out of AI quota. Ask your workspace owner to upgrade.";

/** Member-facing copy for wallet-billed workspaces — the owner recharges, not upgrades. */
export const QUOTA_MEMBER_WALLET_MESSAGE =
  "The workspace has run out of AI quota. Ask your workspace owner to recharge the prepaid wallet.";

/** Member-facing copy when upgrade requests are disabled. */
export const QUOTA_MEMBER_PLAIN_MESSAGE = "The workspace is out of AI quota.";

/**
 * True when the current workspace is wallet-billed (prepaid). Falls back to
 * false while loading or on error, which keeps the existing quota copy.
 */
export function useWalletBilling(): boolean {
  const wallet = useWalletGetOverview({
    query: { queryKey: getWalletGetOverviewQueryKey(), staleTime: 60_000 },
  });
  return wallet.data?.walletBilling === true;
}

/**
 * Title for a 402 notice: wallet-billed workspaces ran out of prepaid
 * balance, not "quota" — calling it a quota reads like a plan limit they
 * don't have.
 */
export function quotaErrorTitle(walletBilling: boolean, quotaTitle = "AI quota reached"): string {
  return walletBilling ? "Wallet balance too low" : quotaTitle;
}

/**
 * Message for a quota (402) error.
 *
 * Owners get the server's text (it tells them to upgrade or buy credits,
 * which they can actually do). Team members can't act on that advice, so
 * they get role-appropriate copy instead: "ask your owner" when upgrade
 * requests are enabled, or a plain out-of-quota notice when they're not.
 *
 * Wallet-billed (prepaid) workspaces don't have plan upgrades or credit
 * packs. For their owners, wallet-flavored server messages (e.g. "This video
 * needs 4 generations and your wallet balance can't cover it. Recharge to
 * continue.") are shown verbatim; other server text is replaced with generic
 * recharge guidance. Their members are told to ask the owner to recharge.
 */
export function quotaErrorMessage(
  err: unknown,
  opts?: { isOwner?: boolean; upgradeRequestsEnabled?: boolean; walletBilling?: boolean },
): string {
  if (opts?.isOwner === false) {
    // Wallet-billed members must always hear the real funding reason —
    // recharging is an owner action outside the upgrade-requests feature,
    // so that flag never downgrades this copy to the plain quota line.
    if (opts.walletBilling) return QUOTA_MEMBER_WALLET_MESSAGE;
    return opts.upgradeRequestsEnabled
      ? QUOTA_MEMBER_ASK_OWNER_MESSAGE
      : QUOTA_MEMBER_PLAIN_MESSAGE;
  }
  const data = (err as { data?: { error?: string } | null } | null)?.data;
  const serverMessage =
    typeof data?.error === "string" && data.error.trim() ? data.error.trim() : null;
  if (opts?.walletBilling) {
    // Wallet-billed workspaces never hit the plan-quota branch on the server,
    // so a wallet-flavored 402 message explains the actual shortfall — prefer
    // it over the generic recharge line. Credit-pack/upgrade oriented server
    // text is wrong for them and gets replaced.
    if (serverMessage && /wallet|recharge/i.test(serverMessage)) return serverMessage;
    return QUOTA_OWNER_WALLET_MESSAGE;
  }
  return serverMessage || QUOTA_FALLBACK_MESSAGE;
}

/**
 * Tappable notice shown wherever an AI generation hit the monthly quota.
 * Tapping it opens the QuotaInfoSheet with the full explanation.
 */
export function QuotaErrorNotice({
  message,
  onPress,
  title,
}: {
  message: string;
  onPress: () => void;
  /** Optional bold heading, e.g. quotaErrorTitle(walletBilling, "Video quota reached"). */
  title?: string;
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
        {title ? <Text style={styles.noticeTitle}>{title}</Text> : null}
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
  isOwner = true,
  upgradeRequestsEnabled = true,
}: {
  visible: boolean;
  onClose: () => void;
  /** Defaults to owner copy; pass false for team members so the "get more" advice is actionable. */
  isOwner?: boolean;
  upgradeRequestsEnabled?: boolean;
}) {
  const insets = useSafeAreaInsets();
  // Wallet-billed (prepaid) workspaces should be pointed at recharging the
  // wallet, not credit packs. Only fetch while the sheet is open; if the
  // lookup hasn't resolved (or fails) we fall back to the quota copy.
  const wallet = useWalletGetOverview({
    query: { queryKey: getWalletGetOverviewQueryKey(), enabled: visible },
  });
  if (!visible) return null;
  const walletBilling = wallet.data?.walletBilling === true;
  // Members can't upgrade the plan, buy credit packs, or recharge the wallet,
  // so the "need more?" guidance points them at the workspace owner instead
  // of Settings > Billing.
  const getMoreText = walletBilling
    ? isOwner
      ? "Need more right away? Recharge your prepaid wallet — generations are paid from your wallet balance."
      : upgradeRequestsEnabled
        ? "Need more right away? Ask your workspace owner to recharge the prepaid wallet — you can send them an upgrade request from the studio."
        : "Need more right away? Ask your workspace owner to recharge the prepaid wallet."
    : isOwner
      ? "Need more right away? Upgrade your plan or buy a credit pack. Credits are used automatically once your monthly allowance runs out."
      : upgradeRequestsEnabled
        ? "Need more right away? Ask your workspace owner to upgrade the plan or buy a credit pack — you can send them an upgrade request from the studio."
        : "Need more right away? Ask your workspace owner to upgrade the plan or buy a credit pack.";
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
            <Text style={styles.rowText}>{getMoreText}</Text>
          </View>

          {isOwner ? (
            <View style={styles.row}>
              <Feather name="globe" size={16} color={c.primary} style={styles.rowIcon} />
              <Text style={styles.rowText}>
                {walletBilling
                  ? "Wallet recharges are managed on the KOKAO web app: open Settings, then Billing."
                  : "Upgrades and credit packs are managed on the KOKAO web app: open Settings, then Billing."}
              </Text>
            </View>
          ) : null}

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
  noticeTitle: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: c.accentForeground,
    marginBottom: 2,
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
