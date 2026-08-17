import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useAudioPlayer } from "expo-audio";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBrandKits,
  useGetBrandKit,
  useGetBrandVoiceStatus,
  usePreviewBrandVoice,
  useRemoveBrandVoice,
  useCreateBrandKitVersion,
  useCreateBrandVoiceAudio,
  getListBrandKitsQueryKey,
  getGetBrandKitQueryKey,
  getGetBrandVoiceStatusQueryKey,
  type BrandKitPayload,
} from "@workspace/api-client-react";

import { Button, Card, Chip, EmptyState, ErrorState, Label, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { haptic } from "@/lib/haptics";

const c = colors.light;
const domain = process.env.EXPO_PUBLIC_DOMAIN;

/** The six stock narration voices (mirrors the web Brand Kit picker). */
const STOCK_VOICES: { value: string; label: string; hint: string }[] = [
  { value: "alloy", label: "Alloy", hint: "balanced" },
  { value: "echo", label: "Echo", hint: "calm" },
  { value: "fable", label: "Fable", hint: "expressive" },
  { value: "onyx", label: "Onyx", hint: "deep" },
  { value: "nova", label: "Nova", hint: "bright" },
  { value: "shimmer", label: "Shimmer", hint: "warm" },
];

export default function BrandVoiceScreen() {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    getToken().then((t) => {
      if (mounted) setToken(t);
    });
    return () => {
      mounted = false;
    };
  }, [getToken]);

  const kitsQuery = useListBrandKits(undefined, {
    query: { queryKey: getListBrandKitsQueryKey() },
  });
  const status = useGetBrandVoiceStatus({
    query: { queryKey: getGetBrandVoiceStatusQueryKey() },
  });

  const kits = useMemo(
    () => (kitsQuery.data ?? []).filter((k) => !k.isArchived),
    [kitsQuery.data],
  );
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const kitId =
    selectedKitId ??
    kits.find((k) => k.isDefault)?.id ??
    kits[0]?.id ??
    null;

  const detailQuery = useGetBrandKit(kitId ?? 0, {
    query: {
      queryKey: getGetBrandKitQueryKey(kitId ?? 0),
      enabled: kitId !== null,
    },
  });
  const detail = detailQuery.data;
  const activePayload = detail?.activeVersion?.payload;
  const brandVoice = activePayload?.brand_voice ?? null;
  const cloned = brandVoice?.mode === "cloned" && !!brandVoice.provider_voice_id;

  const featureOff = status.data ? !status.data.enabled : false;
  const unconfigured = status.data ? !status.data.configured : false;

  // Local edits to the stock voice / delivery style; seeded from the kit.
  const [presetVoice, setPresetVoice] = useState<string | null>(null);
  const [deliveryStyle, setDeliveryStyle] = useState<string | null>(null);
  useEffect(() => {
    // Re-seed the local editor whenever the kit changes.
    setPresetVoice(null);
    setDeliveryStyle(null);
  }, [kitId]);
  const effectiveVoice =
    presetVoice ?? brandVoice?.preset_voice ?? "alloy";
  const effectiveStyle =
    deliveryStyle ?? brandVoice?.delivery_style ?? "";
  const dirty =
    (presetVoice !== null && presetVoice !== (brandVoice?.preset_voice ?? "alloy")) ||
    (deliveryStyle !== null && deliveryStyle !== (brandVoice?.delivery_style ?? ""));

  const previewVoice = usePreviewBrandVoice();
  const removeVoice = useRemoveBrandVoice();
  const createVersion = useCreateBrandKitVersion();
  const createAudio = useCreateBrandVoiceAudio();

  const player = useAudioPlayer();
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [audioScript, setAudioScript] = useState("");
  const [generatedAudioPath, setGeneratedAudioPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    // A different kit means any generated preview/audio no longer applies.
    setPreviewPath(null);
    setGeneratedAudioPath(null);
    setAudioScript("");
    setNotice(null);
  }, [kitId]);

  const playPath = (audioPath: string) => {
    if (!domain || !token) return;
    player.replace({
      uri: `https://${domain}/api/storage${audioPath}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    player.seekTo(0);
    player.play();
  };

  const handlePreview = () => {
    haptic();
    if (previewPath) {
      playPath(previewPath);
      return;
    }
    if (kitId === null) return;
    previewVoice.mutate(
      { id: kitId, data: {} },
      {
        onSuccess: ({ audioPath }) => {
          setPreviewPath(audioPath);
          setNotice({ kind: "info", text: "Preview ready — playing your brand voice." });
          playPath(audioPath);
        },
        onError: (err) => {
          setNotice({
            kind: "error",
            text: apiErrorMessage(err, "Could not generate a preview."),
          });
        },
      },
    );
  };

  const handleGenerateAudio = () => {
    haptic();
    if (kitId === null || !audioScript.trim()) return;
    setGeneratedAudioPath(null);
    createAudio.mutate(
      { id: kitId, data: { text: audioScript.trim() } },
      {
        onSuccess: ({ audioPath }) => {
          setGeneratedAudioPath(audioPath);
          setNotice({ kind: "info", text: "Audio ready — playing now." });
          playPath(audioPath);
        },
        onError: (err) => {
          setNotice({
            kind: "error",
            text: apiErrorMessage(err, "Could not generate audio."),
          });
        },
      },
    );
  };

  const handleShareAudio = async () => {
    if (!domain || !generatedAudioPath) return;
    const url = `https://${domain}/api/storage${generatedAudioPath}`;
    try {
      await Share.share({ url, message: url });
    } catch {
      // user dismissed — ignore
    }
  };

  const afterVersionChange = () => {
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
    if (kitId !== null) {
      queryClient.invalidateQueries({ queryKey: getGetBrandKitQueryKey(kitId) });
    }
  };

  const handleRemove = () => {
    setConfirmRemove(false);
    if (kitId === null) return;
    removeVoice.mutate(
      { id: kitId },
      {
        onSuccess: () => {
          setPreviewPath(null);
          setPresetVoice(null);
          setDeliveryStyle(null);
          setNotice({
            kind: "info",
            text: "Brand voice removed. Narration goes back to the stock voices.",
          });
          afterVersionChange();
        },
        onError: (err) => {
          setNotice({
            kind: "error",
            text: apiErrorMessage(err, "Could not remove the brand voice."),
          });
        },
      },
    );
  };

  const handleSavePreset = () => {
    haptic();
    if (kitId === null || !activePayload) return;
    // Deep-clone the full active payload so every other section is preserved
    // verbatim; only brand_voice changes in the new version.
    const payload = JSON.parse(JSON.stringify(activePayload)) as BrandKitPayload;
    const existingVoice = payload.brand_voice;
    payload.brand_voice = {
      mode: existingVoice?.mode ?? "preset",
      provider: existingVoice?.provider ?? null,
      provider_voice_id: existingVoice?.provider_voice_id ?? null,
      sample_asset_path: existingVoice?.sample_asset_path ?? null,
      cloned_label: existingVoice?.cloned_label ?? null,
      cloned_at: existingVoice?.cloned_at ?? null,
      preset_voice: effectiveVoice,
      delivery_style: effectiveStyle,
    };
    createVersion.mutate(
      {
        id: kitId,
        data: {
          payload,
          sourceType: "manual",
          approvalStatus: "approved",
          activate: true,
        },
      },
      {
        onSuccess: () => {
          setPresetVoice(null);
          setDeliveryStyle(null);
          setNotice({ kind: "info", text: "Voice settings saved." });
          afterVersionChange();
        },
        onError: (err) => {
          setNotice({
            kind: "error",
            text: apiErrorMessage(err, "Could not save the voice settings."),
          });
        },
      },
    );
  };

  if (kitsQuery.isLoading) {
    return (
      <View style={styles.pad}>
        <Skeleton height={90} />
        <Skeleton height={160} style={{ marginTop: 12 }} />
      </View>
    );
  }
  if (kitsQuery.isError) {
    return (
      <View style={styles.pad}>
        <ErrorState
          message={kitsQuery.error?.message}
          onRetry={() => kitsQuery.refetch()}
        />
      </View>
    );
  }
  if (kits.length === 0) {
    return (
      <View style={styles.pad}>
        <EmptyState
          icon="mic"
          title="No brand kits yet"
          subtitle="Create a brand kit in the web app first — its voice settings will show up here."
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      {kits.length > 1 ? (
        <>
          <Label>Brand</Label>
          <View style={styles.chipRow}>
            {kits.map((kit) => (
              <Chip
                key={kit.id}
                label={kit.isDefault ? `${kit.name} (default)` : kit.name}
                selected={kitId === kit.id}
                onPress={() => setSelectedKitId(kit.id)}
              />
            ))}
          </View>
        </>
      ) : null}

      {featureOff ? (
        <Card style={styles.noticeCard}>
          <Text style={styles.noticeText} testID="text-brand-voice-disabled">
            Voice cloning is currently turned off. Videos use the stock voice
            picked below.
          </Text>
        </Card>
      ) : unconfigured ? (
        <Card style={styles.noticeCard}>
          <Text style={styles.noticeText} testID="text-brand-voice-unconfigured">
            Voice cloning isn't set up yet — ask your administrator to finish
            setting it up. Until then, videos use the stock voice picked below.
          </Text>
        </Card>
      ) : null}

      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.iconWrap}>
            <Feather name="mic" size={16} color={c.primary} />
          </View>
          <Text style={styles.cardTitle}>Brand voice</Text>
          {cloned ? (
            <View style={styles.clonedBadge}>
              <Text style={styles.clonedBadgeText}>Cloned voice active</Text>
            </View>
          ) : null}
        </View>

        {detailQuery.isLoading ? (
          <Skeleton height={60} />
        ) : cloned && brandVoice ? (
          <View style={{ gap: 10 }}>
            <Text style={styles.bodyText}>
              <Text style={styles.bodyStrong}>
                {brandVoice.cloned_label ?? "Brand voice"}
              </Text>
              {brandVoice.cloned_at
                ? ` · cloned ${new Date(brandVoice.cloned_at).toLocaleDateString()}`
                : ""}
            </Text>
            <Text style={styles.mutedText}>
              Video narration is spoken in this cloned voice. To record a new
              sample, use the web app.
            </Text>
            <View style={styles.btnRow}>
              <Button
                title={previewVoice.isPending ? "Generating..." : "Play preview"}
                variant="secondary"
                loading={previewVoice.isPending}
                disabled={previewVoice.isPending || featureOff || unconfigured}
                onPress={handlePreview}
              />
              <Button
                title="Remove"
                variant="destructive"
                disabled={removeVoice.isPending}
                loading={removeVoice.isPending}
                onPress={() => setConfirmRemove(true)}
              />
            </View>

            {/* Generate audio in cloned voice */}
            <View style={styles.divider} />
            <Text style={styles.cardTitle}>Generate audio</Text>
            <Text style={styles.mutedText}>
              Type a script and generate an audio file spoken in your cloned
              voice.
            </Text>
            <TextInput
              value={audioScript}
              onChangeText={setAudioScript}
              placeholder="Type your script here… (up to 2500 characters)"
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.scriptInput]}
              multiline
              maxLength={2500}
              testID="input-audio-script"
            />
            <Text style={styles.charCount}>
              {audioScript.length} / 2500
            </Text>
            <Button
              title={createAudio.isPending ? "Generating…" : "Generate audio"}
              loading={createAudio.isPending}
              disabled={
                !audioScript.trim() ||
                createAudio.isPending ||
                featureOff ||
                unconfigured
              }
              onPress={handleGenerateAudio}
              testID="btn-generate-audio"
            />
            {generatedAudioPath ? (
              <View style={styles.btnRow}>
                <Button
                  title="Play again"
                  variant="secondary"
                  onPress={() => playPath(generatedAudioPath)}
                  testID="btn-play-audio"
                />
                <Button
                  title="Share / Save"
                  variant="secondary"
                  onPress={handleShareAudio}
                  testID="btn-share-audio"
                />
              </View>
            ) : null}
          </View>
        ) : (
          <Text style={styles.mutedText} testID="text-brand-voice-stock">
            Narration uses the stock voice picked below. To clone your own
            voice from a recording, use the web app.
          </Text>
        )}
      </Card>

      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Stock voice</Text>
        <Text style={styles.mutedText}>
          {cloned
            ? "Used when the cloned voice isn't available."
            : "The narrator for your videos."}
        </Text>
        <View style={styles.voiceGrid}>
          {STOCK_VOICES.map((v) => {
            const selected = effectiveVoice === v.value;
            return (
              <Pressable
                key={v.value}
                testID={`voice-${v.value}`}
                onPress={() => {
                  haptic();
                  setPresetVoice(v.value);
                }}
                style={({ pressed }) => [
                  styles.voiceOption,
                  selected && styles.voiceOptionSelected,
                  { opacity: pressed ? 0.85 : 1 },
                ]}
              >
                <Text
                  style={[styles.voiceLabel, selected && styles.voiceLabelSelected]}
                >
                  {v.label}
                </Text>
                <Text
                  style={[styles.voiceHint, selected && styles.voiceHintSelected]}
                >
                  {v.hint}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Label>Delivery style</Label>
        <TextInput
          value={effectiveStyle}
          onChangeText={setDeliveryStyle}
          placeholder="e.g. upbeat and friendly, slower pace"
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          testID="input-delivery-style"
        />

        <Button
          title={createVersion.isPending ? "Saving..." : "Save voice settings"}
          disabled={!dirty || createVersion.isPending || !activePayload}
          loading={createVersion.isPending}
          onPress={handleSavePreset}
        />
      </Card>

      {notice ? (
        <Text
          style={[styles.notice, notice.kind === "error" && styles.noticeError]}
          testID="text-brand-voice-notice"
        >
          {notice.text}
        </Text>
      ) : null}

      <Modal
        visible={confirmRemove}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmRemove(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove brand voice?</Text>
            <Text style={styles.mutedText}>
              Video narration will go back to the stock voices. The cloned
              voice can't be restored without re-uploading a sample.
            </Text>
            <View style={styles.btnRow}>
              <Button
                title="Cancel"
                variant="secondary"
                onPress={() => setConfirmRemove(false)}
              />
              <Button title="Remove" variant="destructive" onPress={handleRemove} />
            </View>
          </View>
        </View>
      </Modal>

      {detailQuery.isFetching && !detailQuery.isLoading ? (
        <ActivityIndicator style={{ marginTop: 8 }} color={c.mutedForeground} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16, gap: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  card: { gap: 10 },
  noticeCard: { backgroundColor: c.muted },
  noticeText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.mutedForeground,
    lineHeight: 19,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  clonedBadge: {
    backgroundColor: c.accent,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  clonedBadgeText: { fontFamily: fonts.semiBold, fontSize: 11, color: c.primary },
  bodyText: { fontFamily: fonts.regular, fontSize: 14, color: c.foreground },
  bodyStrong: { fontFamily: fonts.semiBold },
  mutedText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    lineHeight: 19,
  },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  voiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  voiceOption: {
    width: "31%",
    minWidth: 96,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
    backgroundColor: c.background,
  },
  voiceOptionSelected: { borderColor: c.primary, backgroundColor: c.accent },
  voiceLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: c.foreground },
  voiceLabelSelected: { color: c.primary },
  voiceHint: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground },
  voiceHintSelected: { color: c.primary },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.foreground,
    backgroundColor: c.background,
    marginBottom: 8,
  },
  scriptInput: {
    minHeight: 100,
    textAlignVertical: "top",
    marginBottom: 2,
  },
  charCount: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.mutedForeground,
    textAlign: "right",
    marginBottom: 4,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginVertical: 4,
  },
  notice: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  noticeError: { color: c.destructive },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: c.background,
    borderRadius: colors.radius * 2,
    padding: 20,
    gap: 12,
    width: "100%",
    maxWidth: 420,
  },
  modalTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: c.foreground },
});
