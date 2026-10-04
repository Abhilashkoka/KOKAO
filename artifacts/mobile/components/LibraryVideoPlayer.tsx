import React, { useEffect, useState } from "react";
import { useAuth } from "@clerk/expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { Text, View } from "react-native";
import colors from "@/constants/colors";

export function LibraryVideoPlayer({ path }: { path: string }) {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  useEffect(() => {
    let live = true;
    getToken().then((value) => {
      if (live) {
        setToken(value);
        if (!value) setError("Sign in again to preview this video.");
      }
    }).catch(() => { if (live) setError("Could not authorize the video preview. Reopen this item to retry."); });
    return () => { live = false; };
  }, [getToken, path]);
  const player = useVideoPlayer(domain && token
    ? { uri: `https://${domain}/api/storage${path}`, headers: { Authorization: `Bearer ${token}` } }
    : null);
  useEffect(() => {
    const subscription = player.addListener("statusChange", ({ status }) => {
      if (status === "error") setError("The video preview could not load. Reopen this item to retry; do not publish before reviewing it.");
    });
    return () => subscription.remove();
  }, [player]);
  return <View>
    {error ? <Text style={{ color: colors.light.destructive }}>{error}</Text>
      : domain && token ? <VideoView player={player} nativeControls contentFit="contain" style={{ width: "100%", height: 260 }} />
        : <Text style={{ color: colors.light.mutedForeground }}>Loading video preview…</Text>}
  </View>;
}