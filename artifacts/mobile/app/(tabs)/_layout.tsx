import { useAuth } from "@clerk/expo";
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Redirect, Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";
import {
  useListVideoJobs,
  getListVideoJobsQueryKey,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { fonts } from "@/constants/fonts";

function NativeTabLayout({ activeVideoCount }: { activeVideoCount: number }) {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>Home</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="studio">
        <Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <Label>Studio</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="library">
        <View>
          <Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} />
          {activeVideoCount > 0 ? <View style={nativeStyles.dot} /> : null}
        </View>
        <Label>Library</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="accounts">
        <Icon sf={{ default: "link", selected: "link" }} />
        <Label>Accounts</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

const nativeStyles = StyleSheet.create({
  dot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ef4444",
    borderWidth: 1.5,
    borderColor: "#ffffff",
  },
});

function ClassicTabLayout({ activeVideoCount }: { activeVideoCount: number }) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 11 },
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="house" tintColor={color} size={24} />
            ) : (
              <Feather name="home" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="studio"
        options={{
          title: "Studio",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="sparkles" tintColor={color} size={24} />
            ) : (
              <Feather name="zap" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: "Library",
          tabBarBadge: activeVideoCount > 0 ? activeVideoCount : undefined,
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="square.grid.2x2" tintColor={color} size={24} />
            ) : (
              <Feather name="grid" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: "Accounts",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="link" tintColor={color} size={24} />
            ) : (
              <Feather name="link" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  // Note: the API auth token getter is registered at the root layout
  // (ApiAuthBridge) so it is in place before ANY authed screen mounts,
  // including deep-linked screens outside the tab navigator.
  const { isSignedIn } = useAuth();

  // Poll for in-flight video jobs so the Library tab badge updates regardless
  // of which tab is active. Polling stops when all jobs reach a terminal state.
  const videoJobsQuery = useListVideoJobs({
    query: {
      queryKey: getListVideoJobsQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.some(
          (job) => job.status === "queued" || job.status === "processing",
        )
          ? 5000
          : false,
      refetchIntervalInBackground: false,
    },
  });
  const activeVideoCount = (videoJobsQuery.data ?? []).filter(
    (job) => job.status === "queued" || job.status === "processing",
  ).length;

  if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;

  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout activeVideoCount={activeVideoCount} />;
  }
  return <ClassicTabLayout activeVideoCount={activeVideoCount} />;
}
