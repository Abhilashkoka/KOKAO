import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  getGetGamificationQueryKey,
  getGetCreditsQueryKey,
  getGetMeQueryKey,
  getGetReferralInfoQueryKey,
  useClaimGamificationReward,
  useGetGamification,
  useGetMe,
  useGetReferralInfo,
  type RewardAmounts,
} from "@workspace/api-client-react";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { Button, Card } from "@/components/ui";
import { useCreditBalance } from "@/lib/creditBalance";

const c = colors.light;

function formatCredits(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function rewardText(reward: RewardAmounts): string {
  if (typeof reward.credits === "number" && Number.isFinite(reward.credits)) {
    return `+${formatCredits(reward.credits)} credits`;
  }
  const legacy: string[] = [];
  if (reward.captionCredits > 0) legacy.push(`${reward.captionCredits} caption`);
  if (reward.imageCredits > 0) legacy.push(`${reward.imageCredits} image`);
  if (reward.videoCredits > 0) legacy.push(`${reward.videoCredits} video`);
  if (!legacy.length) return reward.mappingError || "";
  return reward.mappingError
    ? `Legacy: ${legacy.join(" + ")} · credit mapping needed`
    : `Legacy: ${legacy.join(" + ")} credits`;
}

function referralReward(
  canonical: number | null | undefined,
  caption: number,
  image: number,
): string {
  if (typeof canonical === "number" && Number.isFinite(canonical)) {
    return `${formatCredits(canonical)} credits`;
  }
  const legacy: string[] = [];
  if (caption > 0) legacy.push(`${caption} caption`);
  if (image > 0) legacy.push(`${image} image`);
  return legacy.length ? `${legacy.join(" + ")} (legacy balances)` : "not configured";
}

export function GamificationCard() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: state } = useGetGamification({
    query: { queryKey: getGetGamificationQueryKey(), staleTime: 30_000 },
  });
  const { data: me } = useGetMe();
  const { data: creditWallet } = useCreditBalance();
  const claim = useClaimGamificationReward();
  const [expanded, setExpanded] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!state) return null;
  const visible =
    state.questsEnabled ||
    state.streaksEnabled ||
    state.referralsEnabled ||
    state.progressMeterEnabled;
  if (!visible) return null;

  const unclaimedQuests = state.quests.filter((quest) => !quest.claimed);
  const claimableCount =
    state.quests.filter((quest) => quest.completed && !quest.claimed).length +
    state.streak.milestones.filter(
      (milestone) => milestone.reached && !milestone.claimed && milestone.claimKey,
    ).length;
  const meterRows =
    state.progressMeterEnabled && me
      ? (
          [
            { label: "Captions", used: me.usage.captions, limit: me.limits.captions },
            { label: "Images", used: me.usage.images, limit: me.limits.images },
            { label: "Videos", used: me.usage.videos ?? 0, limit: me.limits.videos ?? 0 },
          ] as const
        ).filter((row) => row.limit > 0)
      : [];
  const meterMax = meterRows.length
    ? Math.max(...meterRows.map((row) => Math.min(1, row.used / row.limit)))
    : 0;
  const legacy = me?.credits;
  const unifiedBalance = creditWallet?.balance ?? me?.balance;

  const onClaim = (key: string) => {
    setNotice(null);
    claim.mutate(
      { data: { key } },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({ queryKey: getGetGamificationQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetCreditsQueryKey() });
          setNotice(`Reward claimed: ${rewardText(result.granted)}.`);
        },
        onError: (error) => {
          const message =
            (error as { message?: string } | undefined)?.message ||
            "Could not claim this reward. Please try again.";
          setNotice(message);
        },
      },
    );
  };

  return (
    <>
      <Card style={styles.card} testID="mobile-gamification-card">
        <View style={styles.header}>
          <View style={styles.headerTitle}>
            <View style={styles.sparkle}>
              <Feather name="star" size={14} color={c.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Level up</Text>
              {claimableCount > 0 ? (
                <Text style={styles.claimable}>
                  {claimableCount} reward{claimableCount === 1 ? "" : "s"} ready
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.headerActions}>
            {state.streaksEnabled ? (
              <View style={styles.streak}>
                <Feather name="zap" size={14} color={c.accentForeground} />
                <Text style={styles.streakText}>{state.streak.currentDays}d</Text>
              </View>
            ) : null}
            {state.referralsEnabled ? (
              <Pressable
                onPress={() => setReferralOpen(true)}
                style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.7 : 1 }]}
                accessibilityLabel="Invite friends and earn credits"
                testID="mobile-open-referral"
              >
                <Feather name="users" size={17} color={c.primary} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {notice ? (
          <View style={styles.notice} testID="mobile-gamification-toast">
            <Feather
              name={notice.startsWith("Reward claimed") ? "check-circle" : "alert-circle"}
              size={14}
              color={notice.startsWith("Reward claimed") ? c.success : c.destructive}
            />
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.detailsButton, { opacity: pressed ? 0.7 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Hide rewards details" : "Show rewards details"}
          testID="mobile-toggle-gamification"
        >
          <Text style={styles.detailsText}>{expanded ? "Hide details" : "Show details"}</Text>
          <Feather
            name="chevron-down"
            size={15}
            color={c.mutedForeground}
            style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
          />
        </Pressable>

        {expanded && state.streaksEnabled && state.streak.milestones.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Creation streak</Text>
            <Text style={styles.sectionHint}>
              {state.streak.activeToday
                ? "Create again tomorrow to keep your streak going."
                : "Create today to start or continue your streak."}
            </Text>
            <View style={styles.milestones}>
              {state.streak.milestones.map((milestone) => (
                <View key={milestone.days} style={styles.milestone}>
                  <Text style={styles.milestoneDays}>{milestone.days}d</Text>
                  <Text style={styles.milestoneReward}>{rewardText(milestone.reward)}</Text>
                  {milestone.claimed ? (
                    <Feather name="check" size={14} color={c.success} />
                  ) : milestone.reached && milestone.claimKey ? (
                    <Pressable
                      onPress={() => onClaim(milestone.claimKey!)}
                      disabled={claim.isPending || milestone.reward.credits === null}
                      style={({ pressed }) => [
                        styles.claimLink,
                        { opacity: pressed || claim.isPending ? 0.5 : 1 },
                      ]}
                      testID={`mobile-claim-streak-${milestone.days}`}
                    >
                      <Text style={styles.claimLinkText}>Claim</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {expanded && state.questsEnabled && unclaimedQuests.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Getting started</Text>
            <View style={{ gap: 8 }}>
              {unclaimedQuests.map((quest) => (
                <View key={quest.id} style={styles.quest}>
                  <Feather
                    name={quest.completed ? "check-circle" : "circle"}
                    size={17}
                    color={quest.completed ? c.primary : c.mutedForeground}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.questTitle}>{quest.title}</Text>
                    <Text style={styles.questDescription}>
                      {quest.completed ? rewardText(quest.reward) : quest.description}
                    </Text>
                  </View>
                  {quest.completed ? (
                    <Button
                      title="Claim"
                      icon="gift"
                      variant="secondary"
                      onPress={() => onClaim(quest.claimKey)}
                      loading={claim.isPending}
                      disabled={claim.isPending || quest.reward.credits === null}
                      testID={`mobile-claim-quest-${quest.id}`}
                      style={styles.claimButton}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {expanded && meterRows.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.meterHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>
                  {meterMax >= 0.7 ? "You're on a roll" : "Your plan this month"}
                </Text>
                <Text style={styles.sectionHint}>Need more room to create?</Text>
              </View>
              <Button
                title="Upgrade"
                variant={meterMax >= 0.7 ? "primary" : "outline"}
                onPress={() => router.push("/settings")}
                testID="mobile-upgrade-meter"
                style={styles.upgradeButton}
              />
            </View>
            {meterRows.map((row) => (
              <View key={row.label} style={styles.meterRow}>
                <View style={styles.meterLabel}>
                  <Text style={styles.meterName}>{row.label}</Text>
                  <Text style={styles.meterValue}>
                    {Math.min(row.used, row.limit)} / {row.limit}
                  </Text>
                </View>
                <View style={styles.track}>
                  <View
                    style={[
                      styles.fill,
                      { width: `${Math.min(100, (row.used / row.limit) * 100)}%` },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {unifiedBalance || legacy ? (
          <View style={styles.balanceSection} testID="mobile-gamification-balance">
            {unifiedBalance ? (
              <>
                <View style={styles.balanceRow}>
                  <Feather name="credit-card" size={14} color={c.primary} />
                  <Text style={styles.balanceText}>
                    {formatCredits(unifiedBalance.total)} unified credits available
                  </Text>
                </View>
                <View style={styles.balanceBreakdown}>
                  <Text style={styles.balanceBreakdownText}>
                    Purchased: {formatCredits(unifiedBalance.purchased)}
                  </Text>
                  <Text style={styles.balanceBreakdownText}>
                    Granted: {formatCredits(unifiedBalance.granted)}
                  </Text>
                </View>
              </>
            ) : null}
            {legacy ? (
              <Text style={styles.legacyText}>
                Legacy balances: {legacy.captionCredits} caption / {legacy.imageCredits} image
                {legacy.videoCredits !== undefined ? ` / ${legacy.videoCredits} video` : ""}
              </Text>
            ) : null}
          </View>
        ) : null}
        {creditWallet?.legacyConversion?.pending &&
        creditWallet.legacyConversion.captionCredits +
          creditWallet.legacyConversion.imageCredits +
          creditWallet.legacyConversion.videoCredits >
          0 ? (
          <Text style={styles.legacyNotice}>
            Legacy balances remain intact and await administrator-approved conversion.
          </Text>
        ) : null}
      </Card>

      <ReferralModal open={referralOpen} onClose={() => setReferralOpen(false)} insets={insets} />
    </>
  );
}

function ReferralModal({
  open,
  onClose,
  insets,
}: {
  open: boolean;
  onClose: () => void;
  insets: { bottom: number };
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const referral = useGetReferralInfo({
    query: { queryKey: getGetReferralInfoQueryKey(), enabled: open },
  });

  const copy = async () => {
    if (!referral.data) return;
    try {
      // Keep the native clipboard module out of the initial screen bundle so
      // web previews and screens that never open this sheet stay portable.
      const Clipboard = await import("expo-clipboard");
      await Clipboard.setStringAsync(referral.data.code);
      setNotice("Invite code copied.");
    } catch {
      setNotice(referral.data.code);
    }
  };

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 18 }]}>
          <View style={styles.modalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle}>Invite friends</Text>
              <Text style={styles.modalSubtitle}>
                Earn unified credits when a friend joins with your code.
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close referral dialog">
              <Feather name="x" size={22} color={c.mutedForeground} />
            </Pressable>
          </View>
          {referral.isLoading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 24 }} />
          ) : referral.isError ? (
            <Text style={styles.errorText}>
              {(referral.error as { message?: string } | undefined)?.message ||
                "Referral rewards are unavailable right now."}
            </Text>
          ) : referral.data ? (
            <ScrollView contentContainerStyle={{ paddingTop: 18 }} showsVerticalScrollIndicator={false}>
              <View style={styles.codeRow}>
                <Text style={styles.code}>{referral.data.code}</Text>
                <Button title="Copy" icon="copy" variant="outline" onPress={copy} />
              </View>
              <Text style={styles.modalDescription}>
                Your friend gets{" "}
                {referralReward(
                  referral.data.refereeCredits,
                  referral.data.refereeCaptionCredits,
                  referral.data.refereeImageCredits,
                )}
                ; you get{" "}
                {referralReward(
                  referral.data.referrerCredits,
                  referral.data.referrerCaptionCredits,
                  referral.data.referrerImageCredits,
                )}{" "}
                per signup.
              </Text>
              <View style={styles.stats}>
                <View style={styles.stat}>
                  <Text style={styles.statValue}>{referral.data.redemptions}</Text>
                  <Text style={styles.statLabel}>signups</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={styles.statValue}>
                    {formatCredits(
                      typeof referral.data.creditsEarned === "number"
                        ? referral.data.creditsEarned
                        : 0,
                    )}
                  </Text>
                  <Text style={styles.statLabel}>credits earned</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={styles.statValue}>
                    {referral.data.captionCreditsEarned + referral.data.imageCreditsEarned}
                  </Text>
                  <Text style={styles.statLabel}>legacy balances</Text>
                </View>
              </View>
              {referral.data.maxRedemptions !== null ? (
                <Text style={styles.modalFootnote}>
                  Up to {referral.data.maxRedemptions} redemptions on this code.
                </Text>
              ) : null}
              {notice ? <Text style={styles.copyNotice}>{notice}</Text> : null}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    padding: 14,
    borderColor: `${c.primary}40`,
    backgroundColor: c.card,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: { flexDirection: "row", alignItems: "center", gap: 9, flex: 1 },
  sparkle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${c.primary}18`,
  },
  title: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  claimable: { fontFamily: fonts.medium, fontSize: 11, color: c.primary, marginTop: 2 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  streak: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: `${c.accent}99`,
  },
  streakText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.accentForeground },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${c.primary}12`,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    marginTop: 12,
    padding: 9,
    borderRadius: 8,
    backgroundColor: c.muted,
  },
  noticeText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.foreground,
    lineHeight: 17,
  },
  detailsButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginTop: 10,
  },
  detailsText: { fontFamily: fonts.medium, fontSize: 12, color: c.mutedForeground },
  section: { marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  sectionTitle: { fontFamily: fonts.semiBold, fontSize: 13, color: c.foreground },
  sectionHint: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground, marginTop: 3, lineHeight: 16 },
  milestones: { gap: 7, marginTop: 9 },
  milestone: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: 8,
    backgroundColor: c.muted,
  },
  milestoneDays: { fontFamily: fonts.bold, fontSize: 12, color: c.primary, width: 25 },
  milestoneReward: { flex: 1, fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground },
  claimLink: { paddingHorizontal: 6, paddingVertical: 3 },
  claimLinkText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.primary },
  quest: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 9,
    borderRadius: 8,
    backgroundColor: c.muted,
  },
  questTitle: { fontFamily: fonts.semiBold, fontSize: 12, color: c.foreground },
  questDescription: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground, marginTop: 2 },
  claimButton: { minHeight: 34, paddingVertical: 7, paddingHorizontal: 9 },
  meterHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  upgradeButton: { minHeight: 36, paddingVertical: 8, paddingHorizontal: 11 },
  meterRow: { marginTop: 9 },
  meterLabel: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  meterName: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground },
  meterValue: { fontFamily: fonts.medium, fontSize: 11, color: c.foreground },
  track: { height: 6, borderRadius: 3, backgroundColor: c.muted, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3, backgroundColor: c.primary },
  balanceSection: { marginTop: 13, gap: 5 },
  balanceRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  balanceText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.foreground },
  balanceBreakdown: { flexDirection: "row", gap: 12, paddingLeft: 19 },
  balanceBreakdownText: { fontFamily: fonts.regular, fontSize: 10, color: c.mutedForeground },
  legacyText: { fontFamily: fonts.regular, fontSize: 10, color: c.mutedForeground, flexShrink: 1 },
  legacyNotice: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.mutedForeground,
    marginTop: 6,
    lineHeight: 16,
  },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  modalSheet: {
    maxHeight: "82%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
    backgroundColor: c.background,
  },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  modalTitle: { fontFamily: fonts.bold, fontSize: 19, color: c.foreground },
  modalSubtitle: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground, marginTop: 3, lineHeight: 17 },
  codeRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  code: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderRadius: 9,
    backgroundColor: c.muted,
    textAlign: "center",
    fontFamily: fonts.bold,
    fontSize: 18,
    letterSpacing: 2,
    color: c.foreground,
  },
  modalDescription: { fontFamily: fonts.regular, fontSize: 13, color: c.mutedForeground, marginTop: 14, lineHeight: 20 },
  stats: { flexDirection: "row", gap: 8, marginTop: 16 },
  stat: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 9, backgroundColor: c.muted },
  statValue: { fontFamily: fonts.bold, fontSize: 16, color: c.foreground },
  statLabel: { fontFamily: fonts.regular, fontSize: 10, color: c.mutedForeground, marginTop: 3, textAlign: "center" },
  modalFootnote: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground, textAlign: "center", marginTop: 14 },
  copyNotice: { fontFamily: fonts.medium, fontSize: 12, color: c.success, textAlign: "center", marginTop: 12 },
  errorText: { fontFamily: fonts.regular, fontSize: 13, color: c.destructive, marginTop: 22, lineHeight: 19 },
});
