import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetFacebookCredentials,
  useGetInstagramCredentials,
  useGetLinkedinStatus,
  useGetThreadsStatus,
  useGetTwitterStatus,
  useGetYoutubeStatus,
} from "@workspace/api-client-react";

import { Badge, Card, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

type Health = "connected" | "broken" | "disconnected" | "loading";

function PlatformCard({
  name,
  icon,
  health,
  accountName,
  detail,
}: {
  name: string;
  icon: keyof typeof Feather.glyphMap;
  health: Health;
  accountName?: string | null;
  detail?: string | null;
}) {
  return (
    <Card style={styles.platformCard}>
      <View style={styles.platformRow}>
        <View
          style={[
            styles.platformIcon,
            {
              backgroundColor:
                health === "connected"
                  ? c.accent
                  : health === "broken"
                    ? "#fdecec"
                    : c.muted,
            },
          ]}
        >
          <Feather
            name={icon}
            size={18}
            color={
              health === "connected"
                ? c.accentForeground
                : health === "broken"
                  ? c.destructive
                  : c.mutedForeground
            }
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.platformName}>{name}</Text>
          {accountName ? (
            <Text style={styles.accountName} numberOfLines={1}>
              {accountName}
            </Text>
          ) : null}
        </View>
        {health === "loading" ? (
          <Skeleton height={22} width={80} />
        ) : health === "connected" ? (
          <Badge label="Connected" tone="success" />
        ) : health === "broken" ? (
          <Badge label="Needs attention" tone="destructive" />
        ) : (
          <Badge label="Not connected" tone="muted" />
        )}
      </View>
      {health === "broken" ? (
        <View style={styles.reconnectBox}>
          <Feather name="alert-triangle" size={14} color={c.destructive} />
          <Text style={styles.reconnectText}>
            {detail ||
              "This connection stopped working. Open KOKAO on the web to reconnect it."}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

export default function AccountsScreen() {
  const insets = useSafeAreaInsets();

  const fb = useGetFacebookCredentials();
  const ig = useGetInstagramCredentials();
  const li = useGetLinkedinStatus();
  const tw = useGetTwitterStatus();
  const yt = useGetYoutubeStatus();
  const th = useGetThreadsStatus();

  const queries = [fb, ig, li, tw, yt, th];
  const refreshing = queries.some((q) => q.isRefetching);
  const onRefresh = () => queries.forEach((q) => q.refetch());

  const metaHealth = (q: typeof fb): Health => {
    if (q.isLoading) return "loading";
    const d = q.data;
    if (!d || !d.saved) return "disconnected";
    return d.verifyStatus === "failed" ? "broken" : "connected";
  };

  const oauthHealth = (q: typeof li): Health => {
    if (q.isLoading) return "loading";
    const d = q.data;
    if (!d) return "disconnected";
    if (d.expired) return "broken";
    return d.connected ? "connected" : "disconnected";
  };

  const brokenCount = [
    metaHealth(fb),
    metaHealth(ig),
    oauthHealth(li),
    oauthHealth(tw),
    oauthHealth(yt),
    oauthHealth(th),
  ].filter((h) => h === "broken").length;

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        paddingTop: insets.top + 20,
        paddingBottom: insets.bottom + 110,
        paddingHorizontal: 20,
        gap: 12,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.title}>Connected Accounts</Text>
      <Text style={styles.subtitle}>
        Health of the social accounts linked to your workspace
      </Text>

      {brokenCount > 0 ? (
        <View style={styles.alertBanner}>
          <Feather name="alert-circle" size={16} color={c.destructive} />
          <Text style={styles.alertText}>
            {brokenCount === 1
              ? "1 connection needs attention. Reconnect it from KOKAO on the web."
              : `${brokenCount} connections need attention. Reconnect them from KOKAO on the web.`}
          </Text>
        </View>
      ) : null}

      <PlatformCard
        name="Facebook Page"
        icon="facebook"
        health={metaHealth(fb)}
        accountName={fb.data?.accountName}
        detail={
          fb.data?.verifyStatus === "failed"
            ? fb.data?.verifyError ||
              "Your Page access token no longer works. Enter a fresh token on the web app."
            : null
        }
      />
      <PlatformCard
        name="Instagram Business"
        icon="instagram"
        health={metaHealth(ig)}
        accountName={ig.data?.accountName}
        detail={
          ig.data?.verifyStatus === "failed"
            ? ig.data?.verifyError ||
              "Your Instagram credentials no longer work. Update them on the web app."
            : null
        }
      />
      <PlatformCard
        name="LinkedIn"
        icon="linkedin"
        health={oauthHealth(li)}
        accountName={li.data?.accountName}
        detail={
          li.data?.expired
            ? "Your LinkedIn access has expired. Reconnect from KOKAO on the web."
            : null
        }
      />
      <PlatformCard
        name="X (Twitter)"
        icon="twitter"
        health={oauthHealth(tw)}
        accountName={tw.data?.accountName}
        detail={
          tw.data?.expired
            ? "Your X connection can no longer publish. Reconnect from KOKAO on the web."
            : null
        }
      />
      <PlatformCard
        name="YouTube"
        icon="youtube"
        health={oauthHealth(yt)}
        accountName={yt.data?.accountName}
        detail={
          yt.data?.expired
            ? "Your YouTube access was revoked. Reconnect from KOKAO on the web."
            : null
        }
      />
      <PlatformCard
        name="Threads"
        icon="at-sign"
        health={oauthHealth(th)}
        accountName={th.data?.accountName}
        detail={
          th.data?.expired
            ? "Your Threads token expired. Reconnect from KOKAO on the web."
            : null
        }
      />

      <View style={styles.note}>
        <Feather name="info" size={14} color={c.mutedForeground} />
        <Text style={styles.noteText}>
          Connecting new accounts and entering credentials is done from KOKAO on the
          web. This screen shows live connection health.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.bold, fontSize: 24, color: c.foreground },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: -6,
    marginBottom: 4,
  },
  alertBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fdecec",
    borderRadius: colors.radius,
    padding: 12,
  },
  alertText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.destructive,
    lineHeight: 18,
  },
  platformCard: { padding: 14 },
  platformRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  platformIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  platformName: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  accountName: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  reconnectBox: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    backgroundColor: "#fdecec",
    borderRadius: colors.radius,
    padding: 10,
  },
  reconnectText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
    lineHeight: 17,
  },
  note: { flexDirection: "row", gap: 8, paddingHorizontal: 4, marginTop: 8 },
  noteText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    lineHeight: 17,
  },
});
