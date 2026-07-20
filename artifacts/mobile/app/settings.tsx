import { Feather } from "@expo/vector-icons";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetMe,
  getGetMeQueryKey,
  useBillingGetOverview,
  getBillingGetOverviewQueryKey,
} from "@workspace/api-client-react";

import { Badge, Card, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

function formatLimit(limit: number): string {
  return limit === -1 ? "Unlimited" : String(limit);
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function UsageRow({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const unlimited = limit === -1;
  const ratio = unlimited || limit === 0 ? 0 : Math.min(used / limit, 1);
  const exhausted = !unlimited && limit > 0 && used >= limit;
  return (
    <View style={styles.usageRow}>
      <View style={styles.usageHeader}>
        <Text style={styles.usageLabel}>{label}</Text>
        <Text style={[styles.usageValue, exhausted ? styles.usageValueOver : null]}>
          {used} / {formatLimit(limit)}
        </Text>
      </View>
      {!unlimited && (
        <View style={styles.barTrack}>
          <View
            style={[
              styles.barFill,
              {
                width: `${Math.round(ratio * 100)}%`,
                backgroundColor: exhausted ? c.destructive : c.primary,
              },
            ]}
          />
        </View>
      )}
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const billing = useBillingGetOverview({
    query: { queryKey: getBillingGetOverviewQueryKey() },
  });

  const refreshing = me.isRefetching || billing.isRefetching;
  const refetchAll = () => {
    me.refetch();
    billing.refetch();
  };

  if (me.isLoading) {
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.container}
      >
        <Skeleton height={90} />
        <Skeleton height={140} />
        <Skeleton height={90} />
      </ScrollView>
    );
  }

  if (me.isError || !me.data) {
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.container}
      >
        <ErrorState message={me.error?.message} onRetry={refetchAll} />
      </ScrollView>
    );
  }

  const { tenant, usage, limits, credits, team } = me.data;
  const overview = billing.data;
  const subscription = overview?.subscription ?? null;
  const periodEnd = formatDate(subscription?.currentPeriodEnd);
  const captionCredits = credits?.captionCredits ?? 0;
  const imageCredits = credits?.imageCredits ?? 0;

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 40 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="award" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Plan</Text>
          <Badge label={tenant.plan.toUpperCase()} />
        </View>
        <InfoRow label="Workspace" value={team?.workspaceName ?? tenant.name} />
        {team ? (
          <InfoRow
            label="Your role"
            value={team.role.charAt(0).toUpperCase() + team.role.slice(1)}
          />
        ) : null}
      </Card>

      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="bar-chart-2" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Monthly AI usage</Text>
        </View>
        <UsageRow label="Captions" used={usage.captions} limit={limits.captions} />
        <UsageRow label="Images" used={usage.images} limit={limits.images} />
        <Text style={styles.hint}>
          Usage resets each month. When the plan quota runs out, prepaid credits are
          used automatically.
        </Text>
      </Card>

      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="zap" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Prepaid credits</Text>
        </View>
        <InfoRow label="Caption credits" value={String(captionCredits)} />
        <InfoRow label="Image credits" value={String(imageCredits)} />
      </Card>

      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="credit-card" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Billing</Text>
        </View>
        {billing.isLoading ? (
          <Skeleton height={40} />
        ) : billing.isError ? (
          <Text style={styles.hint}>Billing details could not be loaded right now.</Text>
        ) : subscription ? (
          <>
            <InfoRow label="Subscription" value={subscription.planId.toUpperCase()} />
            <InfoRow
              label="Billing cycle"
              value={subscription.billingCycle === "yearly" ? "Yearly" : "Monthly"}
            />
            <InfoRow
              label="Status"
              value={
                subscription.status.charAt(0).toUpperCase() + subscription.status.slice(1)
              }
            />
            {periodEnd ? (
              <InfoRow
                label={subscription.cancelAtPeriodEnd ? "Ends on" : "Renews on"}
                value={periodEnd}
              />
            ) : null}
            {subscription.cancelAtPeriodEnd ? (
              <Text style={styles.hint}>
                Your subscription is set to end after the current period. You will move
                to the free plan afterwards.
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.hint}>
            No active paid subscription. You are on the {tenant.plan} plan.
          </Text>
        )}
        <Text style={styles.hint}>
          To change your plan or buy credits, use the web app under Settings &gt;
          Billing.
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 14 },
  card: { gap: 10, padding: 16 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: {
    fontFamily: fonts.semiBold,
    fontSize: 15,
    color: c.foreground,
    flex: 1,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  infoLabel: { fontFamily: fonts.regular, fontSize: 13, color: c.mutedForeground },
  infoValue: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.foreground,
    flexShrink: 1,
    textAlign: "right",
  },
  usageRow: { gap: 6 },
  usageHeader: { flexDirection: "row", justifyContent: "space-between" },
  usageLabel: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground },
  usageValue: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  usageValueOver: { color: c.destructive },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.muted,
    overflow: "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    lineHeight: 17,
  },
});
