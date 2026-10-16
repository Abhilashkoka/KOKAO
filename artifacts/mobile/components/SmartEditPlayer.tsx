import { useAuth } from "@clerk/expo";
import { VideoView, useVideoPlayer } from "expo-video";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import type { SmartEditBox } from "@workspace/api-client-react";
import colors from "@/constants/colors";
import { regionFromPoints } from "@/lib/smartEdit";

const c = colors.light;

/** A keyed inner player mounts once its authenticated source is available. */
export function SmartEditPlayer({
  path, ...props
}: {
  path: string;
  aspectRatio?: string | null;
  drawing?: boolean;
  box?: SmartEditBox | null;
  onBox?: (box: SmartEditBox | null) => void;
  onLoad?: (duration: number) => void;
  onTime?: (time: number) => void;
  seek?: { at: number; nonce: number };
}) {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [browserSource, setBrowserSource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getToken().then((value) => {
      if (live) { setToken(value); setFailed(!value); }
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [getToken, path]);
  useEffect(() => {
    // HTML video cannot attach Authorization headers. Fetch tenant-owned media
    // with the session first, then play a revocable local URL in Expo web.
    // Native iOS/Android continue to stream with headers, without a full download.
    if (Platform.OS !== "web" || !token || !process.env.EXPO_PUBLIC_DOMAIN) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setBrowserSource(null);
    void fetch(`https://${process.env.EXPO_PUBLIC_DOMAIN}/api/storage${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Video unavailable");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setBrowserSource(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [token, path]);
  if (failed || !process.env.EXPO_PUBLIC_DOMAIN) return <Text style={{ color: c.destructive }}>Video preview unavailable. Reopen the editor to try again.</Text>;
  if (!token || (Platform.OS === "web" && !browserSource)) return <ActivityIndicator color={c.primary} />;
  return <AuthenticatedPlayer key={path} path={path} token={token} browserSource={browserSource} {...props} />;
}

function AuthenticatedPlayer({
  path, token, browserSource, aspectRatio, drawing, box, onBox, onLoad, onTime, seek,
}: Omit<React.ComponentProps<typeof SmartEditPlayer>, "path"> & { path: string; token: string; browserSource: string | null }) {
  const [ratio, setRatio] = useState(() => {
    const [w, h] = (aspectRatio ?? "9:16").split(":").map(Number);
    return w && h ? w / h : 9 / 16;
  });
  const [error, setError] = useState<string | null>(null);
  const size = useRef({ width: 0, height: 0 });
  const origin = useRef<[number, number]>([0, 0]);
  const reportedDuration = useRef(false);
  const player = useVideoPlayer({
    uri: browserSource ?? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/storage${path}`,
    headers: { Authorization: `Bearer ${token}` },
  }, (p) => { p.timeUpdateEventInterval = 0.2; });
  const loadRef = useRef(onLoad);
  const timeRef = useRef(onTime);
  loadRef.current = onLoad;
  timeRef.current = onTime;
  useEffect(() => {
    const reportDuration = (duration: number) => {
      if (duration > 0 && Number.isFinite(duration) && !reportedDuration.current) {
        reportedDuration.current = true;
        loadRef.current?.(duration);
      }
    };
    const load = player.addListener("sourceLoad", (event) => {
      const track = event.availableVideoTracks[0];
      if (track?.size.width && track.size.height) setRatio(track.size.width / track.size.height);
      reportDuration(event.duration);
    });
    const time = player.addListener("timeUpdate", (event) => timeRef.current?.(event.currentTime));
    const status = player.addListener("statusChange", (event) => {
      if (event.status === "error") setError("Could not play this video. Reopen the editor to retry.");
      // Expo SDK 54 web doesn't emit sourceLoad; duration is real metadata
      // by readyToPlay. This also covers an already cached native source.
      if (event.status === "readyToPlay") reportDuration(player.duration);
    });
    // Cached native metadata can arrive before the event subscription.
    reportDuration(player.duration);
    return () => { load.remove(); time.remove(); status.remove(); };
  }, [player]);
  useEffect(() => { if (drawing) player.pause(); }, [drawing, player]);
  useEffect(() => {
    if (seek) { player.pause(); player.currentTime = seek.at; }
  }, [seek, player]);
  const move = (event: GestureResponderEvent) => {
    onBox?.(regionFromPoints(origin.current, [event.nativeEvent.locationX, event.nativeEvent.locationY], size.current.width, size.current.height));
  };
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{ aspectRatio: ratio, width: "100%", maxWidth: ratio < 1 ? 260 : undefined, alignSelf: "center", backgroundColor: c.foreground, overflow: "hidden", borderRadius: colors.radius }}
        onLayout={(event) => { size.current = event.nativeEvent.layout; }}
      >
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={!drawing} />
        {(drawing || box) && <View
          testID="smart-edit-region"
          pointerEvents={drawing ? "auto" : "none"}
          style={StyleSheet.absoluteFill}
          onStartShouldSetResponder={() => !!drawing}
          onMoveShouldSetResponder={() => !!drawing}
          onResponderGrant={(event) => {
            origin.current = [event.nativeEvent.locationX, event.nativeEvent.locationY];
            onBox?.(null);
          }}
          onResponderMove={move}
          onResponderRelease={move}
          onResponderTerminationRequest={() => false}
        >
          {box && <View pointerEvents="none" style={{
            position: "absolute", left: `${box.x * 100}%`, top: `${box.y * 100}%`,
            width: `${box.width * 100}%`, height: `${box.height * 100}%`,
            borderWidth: 3, borderColor: c.primary, backgroundColor: c.accent, opacity: 0.45,
          }} />}
        </View>}
      </View>
      {error && <Text accessibilityRole="alert" style={{ color: c.destructive }}>{error}</Text>}
    </View>
  );
}
