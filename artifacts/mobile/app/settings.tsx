import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  getGetMeQueryKey,
  useBillingGetOverview,
  getBillingGetOverviewQueryKey,
  useListPlans,
  getListPlansQueryKey,
  useBillingSubscribe,
  useBillingVerifySubscription,
  useBillingPurchaseCredits,
  useBillingVerifyPurchase,
} from "@workspace/api-client-react";
import type { Plan } from "@workspace/api-client-react";

import { Badge, Card, ErrorState, Skeleton } from "@/components/ui";
import {
  RazorpayCheckoutModal,
  type CheckoutRequest,
} from "@/components/RazorpayCheckoutModal";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

function formatInr(paise: number): string {
  return `\u20B9${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error ?? fallback;
}

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
  const queryClient = useQueryClient();
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const billing = useBillingGetOverview({
    query: { queryKey: getBillingGetOverviewQueryKey() },
  });
  const plans = useListPlans({ query: { queryKey: getListPlansQueryKey() } });
  const subscribe = useBillingSubscribe();
  const verifySubscription = useBillingVerifySubscription();
  const purchaseCredits = useBillingPurchaseCredits();
  const verifyPurchase = useBillingVerifyPurchase();

  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutRequest | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const refreshing = me.isRefetching || billing.isRefetching;
  const refetchAll = () => {
    me.refetch();
    billing.refetch();
  };

  const refreshAfterPurchase = () => {
    queryClient.invalidateQueries({ queryKey: getBillingGetOverviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };

  const startSubscribe = async (plan: Plan) => {
    setNotice(null);
    setBusyId(plan.id);
    try {
      const started = await subscribe.mutateAsync({
        data: { planId: plan.id, billingCycle: cycle },
      });
      setCheckout({
        mode: "subscription",
        keyId: started.keyId,
        subscriptionId: started.razorpaySubscriptionId,
        title: "Upgrade plan",
        description: plan.name,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error, "Could not start checkout. Please try again."),
      });
    } finally {
      setBusyId(null);
    }
  };

  const startBuyPack = async (packId: number, packName: string) => {
    setNotice(null);
    setBusyId(`pack-${packId}`);
    try {
      const order = await purchaseCredits.mutateAsync({
        data: { creditPackId: packId },
      });
      setCheckout({
        mode: "order",
        keyId: order.keyId,
        orderId: order.razorpayOrderId,
        amountPaise: order.amountPaise,
        title: "Buy credits",
        description: packName,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error, "Could not start checkout. Please try again."),
      });
    } finally {
      setBusyId(null);
    }
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

  const isOwner = team ? team.role === "owner" : true;
  const configured = overview?.configured === true;
  const hasActiveSub =
    !!subscription &&
    (subscription.status === "active" || subscription.status === "authenticated") &&
    !subscription.cancelAtPeriodEnd;
  const paidPlans = (plans.data ?? []).filter(
    (p): p is Plan & { priceInr: number } =>
      typeof p.priceInr === "number" && p.priceInr > 0,
  );
  const anyYearly = paidPlans.some(
    (p) => typeof p.priceInrYearly === "number" && p.priceInrYearly > 0,
  );
  const creditPacks = overview?.creditPacks ?? [];
  const canPurchase = isOwner && configured;

  const handleCheckoutSuccess = (result: {
    paymentId: string;
    signature: string;
    subscriptionId?: string;
    orderId?: string;
  }) => {
    const active = checkout;
    setCheckout(null);
    if (!active) return;
    setVerifying(true);
    setNotice({ kind: "info", text: "Confirming your payment..." });
    const done = (kind: "success" | "error", text: string) => {
      setVerifying(false);
      setNotice({ kind, text });
      refreshAfterPurchase();
    };
    if (active.mode === "subscription") {
      if (!result.subscriptionId) {
        done("error", "Payment received; your plan will activate shortly.");
        return;
      }
      verifySubscription.mutate(
        {
          data: {
            razorpaySubscriptionId: result.subscriptionId,
            razorpayPaymentId: result.paymentId,
            razorpaySignature: result.signature,
          },
        },
        {
          onSuccess: () => done("success", "Your plan has been upgraded."),
          onError: (error) =>
            done(
              "error",
              errorMessage(error, "Payment received; your plan will activate shortly."),
            ),
        },
      );
    } else {
      if (!result.orderId) {
        done("error", "Payment received; credits will appear shortly.");
        return;
      }
      verifyPurchase.mutate(
        {
          data: {
            razorpayOrderId: result.orderId,
            razorpayPaymentId: result.paymentId,
            razorpaySignature: result.signature,
          },
        },
        {
          onSuccess: () => done("success", "Credits added to your workspace."),
          onError: (error) =>
            done(
              "error",
              errorMessage(error, "Payment received; credits will appear shortly."),
            ),
        },
      );
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 40 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      {notice ? (
        <View
          style={[
            styles.notice,
            notice.kind === "success"
              ? styles.noticeSuccess
              : notice.kind === "error"
                ? styles.noticeError
                : null,
          ]}
        >
          <Text style={styles.noticeText}>{notice.text}</Text>
        </View>
      ) : null}

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
        {creditPacks.length > 0 ? (
          <View style={styles.packList}>
            {creditPacks.map((pack) => {
              const packBusy = busyId === `pack-${pack.id}`;
              return (
                <View key={pack.id} style={styles.packRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.packName}>{pack.name}</Text>
                    <Text style={styles.packDetail}>
                      {[
                        pack.captionCredits > 0 ? `${pack.captionCredits} captions` : null,
                        pack.imageCredits > 0 ? `${pack.imageCredits} images` : null,
                      ]
                        .filter(Boolean)
                        .join(" + ")}
                      {" \u2014 "}
                      {formatInr(pack.pricePaise)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[
                      styles.buyButton,
                      (!canPurchase || packBusy || verifying) && styles.buttonDisabled,
                    ]}
                    disabled={!canPurchase || packBusy || verifying}
                    onPress={() => startBuyPack(pack.id, pack.name)}
                  >
                    <Text style={styles.buyButtonText}>
                      {packBusy ? "Opening..." : "Buy"}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        ) : null}
        {!isOwner ? (
          <Text style={styles.hint}>
            Only the workspace owner can buy credits or change the plan.
          </Text>
        ) : !configured && !billing.isLoading && overview ? (
          <Text style={styles.hint}>
            Online payments are not set up yet. Purchases will be available once the
            platform administrator adds payment keys.
          </Text>
        ) : null}
      </Card>

      {canPurchase && paidPlans.length > 0 ? (
        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Feather name="trending-up" size={16} color={c.primary} />
            <Text style={styles.cardTitle}>Upgrade plan</Text>
          </View>
          {hasActiveSub ? (
            <Text style={styles.hint}>
              You already have an active subscription. Cancel it from the web app before
              switching plans.
            </Text>
          ) : (
            <>
              {anyYearly ? (
                <View style={styles.cycleToggle}>
                  {(["monthly", "yearly"] as const).map((option) => (
                    <TouchableOpacity
                      key={option}
                      style={[
                        styles.cycleOption,
                        cycle === option && styles.cycleOptionActive,
                      ]}
                      onPress={() => setCycle(option)}
                    >
                      <Text
                        style={[
                          styles.cycleOptionText,
                          cycle === option && styles.cycleOptionTextActive,
                        ]}
                      >
                        {option === "monthly" ? "Monthly" : "Yearly"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              {paidPlans.map((plan) => {
                const hasYearly =
                  typeof plan.priceInrYearly === "number" && plan.priceInrYearly > 0;
                const showYearly = cycle === "yearly" && hasYearly;
                const isCurrent = tenant.plan === plan.id;
                const yearlyUnavailable = cycle === "yearly" && !hasYearly;
                const planBusy = busyId === plan.id;
                return (
                  <View key={plan.id} style={styles.packRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.packName}>{plan.name}</Text>
                      <Text style={styles.packDetail}>
                        {showYearly
                          ? `${formatInr(Math.round(plan.priceInrYearly! / 12))} / month, ${formatInr(plan.priceInrYearly!)} billed yearly`
                          : `${formatInr(plan.priceInr)} / month`}
                        {yearlyUnavailable ? " (monthly billing only)" : ""}
                      </Text>
                    </View>
                    {isCurrent ? (
                      <Badge label="CURRENT" />
                    ) : (
                      <TouchableOpacity
                        style={[
                          styles.buyButton,
                          (planBusy || verifying || yearlyUnavailable) &&
                            styles.buttonDisabled,
                        ]}
                        disabled={planBusy || verifying || yearlyUnavailable}
                        onPress={() => startSubscribe(plan)}
                      >
                        <Text style={styles.buyButtonText}>
                          {planBusy ? "Opening..." : "Upgrade"}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </>
          )}
        </Card>
      ) : null}

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
          Subscription cancellation and detailed billing history are available in the
          web app under Settings &gt; Billing.
        </Text>
      </Card>

      <RazorpayCheckoutModal
        request={checkout}
        onSuccess={handleCheckoutSuccess}
        onFailure={(message) => {
          setCheckout(null);
          setNotice({ kind: "error", text: message });
        }}
        onDismiss={() => setCheckout(null)}
      />
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
  notice: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.muted,
    padding: 12,
  },
  noticeSuccess: {
    borderColor: "#bbf7d0",
    backgroundColor: "#f0fdf4",
  },
  noticeError: {
    borderColor: "#fecaca",
    backgroundColor: "#fef2f2",
  },
  noticeText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.foreground,
    lineHeight: 18,
  },
  packList: {
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    paddingTop: 10,
  },
  packRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  packName: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground },
  packDetail: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  buyButton: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  buyButtonText: {
    fontFamily: fonts.semiBold,
    fontSize: 13,
    color: c.primaryForeground,
  },
  cycleToggle: {
    flexDirection: "row",
    backgroundColor: c.muted,
    borderRadius: 999,
    padding: 3,
    alignSelf: "flex-start",
  },
  cycleOption: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  cycleOptionActive: { backgroundColor: c.background },
  cycleOptionText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.mutedForeground,
  },
  cycleOptionTextActive: { color: c.foreground },
});
