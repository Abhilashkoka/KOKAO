import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetNotificationSettings,
  useUpdateNotificationSettings,
  getGetNotificationSettingsQueryKey,
  useListFeatureFlags,
  getListFeatureFlagsQueryKey,
} from "@workspace/api-client-react";

import { Card, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

type PrefState = { inApp: boolean; email: boolean; push: boolean };

export default function NotificationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const settingsQuery = useGetNotificationSettings({
    query: { queryKey: getGetNotificationSettingsQueryKey() },
  });
  const update = useUpdateNotificationSettings();
  const featuresQuery = useListFeatureFlags({
    query: { queryKey: getListFeatureFlagsQueryKey() },
  });
  const pushFeatureOn = featuresQuery.data?.pushNotifications === true;

  const [prefs, setPrefs] = useState<Record<string, PrefState>>({});

  const data = settingsQuery.data;

  useEffect(() => {
    if (data) {
      const next: Record<string, PrefState> = {};
      for (const t of data.types) {
        next[t.type] = {
          inApp: t.preference.inApp,
          email: t.preference.email,
          push: t.preference.push,
        };
      }
      setPrefs(next);
    }
  }, [data]);

  const memberScoped = data?.scope === "member";

  const handleToggle = (
    type: string,
    channel: keyof PrefState,
    value: boolean,
  ) => {
    if (!data) return;
    const previous = prefs;
    const next = {
      ...prefs,
      [type]: { ...prefs[type], [channel]: value },
    };
    setPrefs(next);
    const preferences = data.types.map((t) => ({
      type: t.type,
      inApp: next[t.type]?.inApp ?? t.preference.inApp,
      email: next[t.type]?.email ?? t.preference.email,
      push: next[t.type]?.push ?? t.preference.push,
    }));
    update.mutate(
      { data: { preferences } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetNotificationSettingsQueryKey(),
          });
        },
        onError: () => {
          setPrefs(previous);
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
        Choose how you want to be alerted for each kind of notification. In-app
        alerts show inside the app; email and push reach you even when the app
        is closed. Changes save automatically.
      </Text>

      {memberScoped ? (
        <View style={styles.infoBox}>
          <Feather name="info" size={14} color={c.mutedForeground} />
          <Text style={styles.infoText}>
            You're a team member of this workspace, so these choices apply only
            to you. Turning email off here stops emails sent to you without
            affecting the workspace owner or other teammates.
          </Text>
        </View>
      ) : null}

      {data && !data.emailConfigured ? (
        <View style={[styles.infoBox, styles.warnBox]}>
          <Feather name="alert-triangle" size={14} color="#b45309" />
          <Text style={styles.infoText}>
            Email delivery isn't connected yet, so email alerts won't send
            until an administrator sets it up. Your choices are saved and take
            effect automatically once email is enabled.
          </Text>
        </View>
      ) : null}

      {settingsQuery.isLoading ? (
        <View style={{ gap: 12, marginTop: 20 }}>
          <Skeleton height={110} />
          <Skeleton height={110} />
          <Skeleton height={110} />
        </View>
      ) : settingsQuery.isError ? (
        <ErrorState
          message={settingsQuery.error?.message}
          onRetry={() => settingsQuery.refetch()}
        />
      ) : data ? (
        <View style={{ gap: 12, marginTop: 20 }}>
          {data.types.map((t) => {
            const pref = prefs[t.type] ?? {
              inApp: t.preference.inApp,
              email: t.preference.email,
              push: t.preference.push,
            };
            const emailLocked = t.emailPolicy !== "optional" || !t.enabled;
            const emailChecked =
              t.enabled &&
              (t.emailPolicy === "forced"
                ? true
                : t.emailPolicy === "off"
                  ? false
                  : pref.email);

            return (
              <Card
                key={t.type}
                style={!t.enabled ? { opacity: 0.6 } : undefined}
              >
                <Text style={styles.typeLabel}>{t.label}</Text>
                <Text style={styles.typeDescription}>{t.description}</Text>
                {!t.enabled ? (
                  <Text style={styles.adminNote}>
                    This notification is turned off by your administrator.
                  </Text>
                ) : null}

                {!memberScoped ? (
                  <View style={styles.channelRow}>
                    <View style={styles.channelLeft}>
                      <Feather
                        name="smartphone"
                        size={15}
                        color={c.mutedForeground}
                      />
                      <Text style={styles.channelText}>In-app alert</Text>
                    </View>
                    <Switch
                      value={t.enabled && pref.inApp}
                      disabled={!t.enabled || update.isPending}
                      onValueChange={(v) => handleToggle(t.type, "inApp", v)}
                      trackColor={{ true: c.primary, false: c.muted }}
                      accessibilityLabel={`Toggle in-app alert for ${t.label}`}
                    />
                  </View>
                ) : null}

                <View style={styles.channelRow}>
                  <View style={styles.channelLeft}>
                    <Feather name="mail" size={15} color={c.mutedForeground} />
                    <Text style={styles.channelText}>Email</Text>
                    {t.emailPolicy === "forced" ? (
                      <Text style={styles.policyNote}>(required by admin)</Text>
                    ) : t.emailPolicy === "off" ? (
                      <Text style={styles.policyNote}>(disabled by admin)</Text>
                    ) : null}
                  </View>
                  <Switch
                    value={emailChecked}
                    disabled={emailLocked || update.isPending}
                    onValueChange={(v) => handleToggle(t.type, "email", v)}
                    trackColor={{ true: c.primary, false: c.muted }}
                    accessibilityLabel={`Toggle email for ${t.label}`}
                  />
                </View>

                {pushFeatureOn ? (
                  <View style={styles.channelRow}>
                    <View style={styles.channelLeft}>
                      <Feather
                        name="bell"
                        size={15}
                        color={c.mutedForeground}
                      />
                      <Text style={styles.channelText}>Push</Text>
                    </View>
                    <Switch
                      value={t.enabled && pref.push}
                      disabled={!t.enabled || update.isPending}
                      onValueChange={(v) => handleToggle(t.type, "push", v)}
                      trackColor={{ true: c.primary, false: c.muted }}
                      accessibilityLabel={`Toggle push for ${t.label}`}
                    />
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>
      ) : null}
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
  infoBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.muted,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 14,
  },
  warnBox: {
    borderColor: "#f6d7a0",
    backgroundColor: "#fdf6e7",
  },
  infoText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: c.mutedForeground,
  },
  typeLabel: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  typeDescription: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: c.mutedForeground,
    marginTop: 3,
  },
  adminNote: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.mutedForeground,
    marginTop: 4,
  },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  channelLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    paddingRight: 12,
  },
  channelText: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground },
  policyNote: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.mutedForeground,
  },
});
