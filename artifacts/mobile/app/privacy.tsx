import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetConsent,
  useUpdateConsent,
  getGetConsentQueryKey,
} from "@workspace/api-client-react";

import { Card, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const CATEGORIES = [
  {
    key: "analytics" as const,
    label: "Usage analytics",
    description:
      "Anonymous-style usage events: screens you visit, features you use, and errors you hit. Helps us improve the product.",
  },
  {
    key: "deviceDetails" as const,
    label: "Device details",
    description:
      "Operating system, device model, network type, and battery state attached to usage events.",
  },
  {
    key: "locationCoarse" as const,
    label: "Approximate location",
    description:
      "City-level location derived from your network connection. No GPS access.",
  },
  {
    key: "locationPrecise" as const,
    label: "Precise location",
    description:
      "Exact coordinates via your device location permission. Only used when you also grant that permission.",
  },
  {
    key: "carrier" as const,
    label: "Mobile carrier",
    description: "Your mobile network operator name.",
  },
];

type ConsentKey = (typeof CATEGORIES)[number]["key"];

export default function PrivacyScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const consentQuery = useGetConsent({
    query: { queryKey: getGetConsentQueryKey() },
  });
  const updateConsent = useUpdateConsent();

  const [flags, setFlags] = useState<Record<ConsentKey, boolean>>({
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
    carrier: false,
  });

  const consent = consentQuery.data;

  useEffect(() => {
    if (consent) {
      setFlags({
        analytics: consent.analytics,
        deviceDetails: consent.deviceDetails,
        locationCoarse: consent.locationCoarse,
        locationPrecise: consent.locationPrecise,
        carrier: consent.carrier,
      });
    }
  }, [consent]);

  const handleToggle = (key: ConsentKey, value: boolean) => {
    const previous = flags;
    setFlags({ ...flags, [key]: value });
    updateConsent.mutate(
      { data: { [key]: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetConsentQueryKey() });
        },
        onError: () => {
          setFlags(previous);
          Alert.alert("Could not save your choice", "Please try again.");
        },
      },
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        padding: 20,
        paddingBottom: insets.bottom + 40,
      }}
    >
      <Text style={styles.intro}>
        Choose what usage data KOKAO may collect. Everything is off by default,
        changes apply immediately, and declining never limits what you can do in
        the app. Billing records and the data needed to run your account (like
        AI usage counts) are kept regardless, as part of operating the service.
      </Text>

      {consentQuery.isLoading ? (
        <View style={{ gap: 12, marginTop: 20 }}>
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
        </View>
      ) : consentQuery.isError ? (
        <ErrorState
          message={consentQuery.error?.message}
          onRetry={() => consentQuery.refetch()}
        />
      ) : (
        <Card style={{ marginTop: 20 }}>
          {CATEGORIES.map((cat, i) => (
            <View
              key={cat.key}
              style={[styles.row, i > 0 && styles.rowBorder]}
            >
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.rowLabel}>{cat.label}</Text>
                <Text style={styles.rowDescription}>{cat.description}</Text>
              </View>
              <Switch
                value={flags[cat.key]}
                onValueChange={(v) => handleToggle(cat.key, v)}
                disabled={updateConsent.isPending}
                trackColor={{ true: c.primary, false: c.muted }}
                accessibilityLabel={cat.label}
              />
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  intro: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: c.mutedForeground,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  rowLabel: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  rowDescription: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: c.mutedForeground,
    marginTop: 3,
  },
});
