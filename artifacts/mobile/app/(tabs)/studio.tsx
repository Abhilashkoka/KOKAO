import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useCreateContent,
  useGenerateCaption,
  useGenerateImage,
  useListBrandKits,
  useListContent,
  useSuggestTopics,
  useUpdateContent,
  getListContentQueryKey,
  getGetContentQueryKey,
  type BrandKit,
  type ContentItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CAPTION_TWEAKS, IMAGE_TWEAKS } from "@workspace/studio-presets";
import { Image } from "expo-image";

import { CaptionSplitHints } from "@/components/CaptionSplitHints";
import { track, trackFeatureUse } from "@/lib/analytics";
import { ContentImage } from "@/components/ContentImage";
import { VoiceNoteButton } from "@/components/VoiceNoteButton";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Button, Card, Chip, EmptyState, Input, Label, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const PLATFORMS = ["instagram", "facebook", "linkedin", "x", "threads"];
const TONES = ["Friendly", "Professional", "Witty", "Bold", "Inspirational"];
const IMAGE_SIZES = [
  { label: "Square", value: "1024x1024" },
  { label: "Landscape", value: "1536x1024" },
  { label: "Portrait", value: "1024x1536" },
] as const;
type ImageSize = (typeof IMAGE_SIZES)[number]["value"];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function kitSwatches(kit: BrandKit, max = 4): string[] {
  const palette = kit.activeVersion?.payload?.colors;
  if (!palette) return [];
  const out: string[] = [];
  for (const group of [palette.primary, palette.secondary, palette.neutral]) {
    for (const color of group ?? []) {
      const hex = color.hex?.trim();
      if (hex && HEX_RE.test(hex) && !out.includes(hex.toLowerCase())) {
        out.push(hex.toLowerCase());
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

function SwatchStrip({ hexes, size = 12 }: { hexes: string[]; size?: number }) {
  if (hexes.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 3 }}>
      {hexes.map((hex, i) => (
        <View
          key={`${hex}-${i}`}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: hex,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: "rgba(0,0,0,0.2)",
          }}
        />
      ))}
    </View>
  );
}

function BrandChip({
  label,
  swatches,
  selected,
  onPress,
}: {
  label: string;
  swatches: string[];
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.brandChip,
        {
          backgroundColor: selected ? c.primary : c.secondary,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.brandChipText,
          { color: selected ? "#ffffff" : c.secondaryForeground },
        ]}
      >
        {label}
      </Text>
      <SwatchStrip hexes={swatches} size={11} />
    </Pressable>
  );
}

function errorMessage(err: unknown): string {
  const anyErr = err as {
    status?: number;
    message?: string;
    data?: { error?: string } | null;
  };
  const serverMessage =
    anyErr?.data && typeof anyErr.data.error === "string" ? anyErr.data.error : null;
  if (anyErr?.status === 402) {
    return (
      serverMessage ||
      "You have reached your monthly AI quota. Upgrade your plan on the web app to continue."
    );
  }
  return serverMessage || anyErr?.message || "Something went wrong. Please try again.";
}

export default function StudioScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState("instagram");
  const [tone, setTone] = useState("Friendly");
  const [brandKitId, setBrandKitId] = useState<number | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize>("1024x1024");
  const [niche, setNiche] = useState("");
  const [ideas, setIdeas] = useState<string[]>([]);
  const [caption, setCaption] = useState<string | null>(null);
  const [captionTweak, setCaptionTweak] = useState<string | null>(null);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imageTweak, setImageTweak] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quotaHit, setQuotaHit] = useState(false);
  const [saved, setSaved] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachingId, setAttachingId] = useState<number | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<ContentItem | null>(null);
  const [attachedTitle, setAttachedTitle] = useState<string | null>(null);

  const brandKits = useListBrandKits();
  const genCaption = useGenerateCaption();
  const genImage = useGenerateImage();
  const suggest = useSuggestTopics();
  const createContent = useCreateContent();
  const updateContent = useUpdateContent();
  const contentList = useListContent({
    query: { queryKey: getListContentQueryKey(), enabled: attachOpen },
  });

  const kits = (brandKits.data ?? []).filter((k) => !k.isArchived);
  const activeKit =
    brandKitId !== null
      ? (kits.find((k) => k.id === brandKitId) ?? null)
      : (kits.find((k) => k.isDefault) ?? null);
  const activeSwatches = activeKit ? kitSwatches(activeKit, 6) : [];

  const haptic = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const setFailure = (err: unknown) => {
    setError(errorMessage(err));
    setQuotaHit((err as { status?: number })?.status === 402);
  };

  const handleSuggest = () => {
    if (!niche.trim()) return;
    setError(null);
    setQuotaHit(false);
    suggest.mutate(
      { data: { niche: niche.trim() } },
      {
        onSuccess: (res) => setIdeas(res.ideas),
        onError: setFailure,
      },
    );
  };

  const runGenerateCaption = (tweak?: string | null) => {
    if (!prompt.trim()) return;
    haptic();
    setError(null);
    setQuotaHit(false);
    setSaved(false);
    setCaptionTweak(tweak ?? null);
    const tweakInstruction = tweak ? ` ${CAPTION_TWEAKS.find((t) => t.label === tweak)?.instruction ?? ""}` : "";
    genCaption.mutate(
      { data: { prompt: `${prompt.trim()}${tweakInstruction}`, platform, tone, brandKitId } },
      {
        onSuccess: (res) => {
          track("caption_generated", { platform, tone });
          trackFeatureUse("studio_caption");
          setCaption(res.caption);
          setHashtags(res.hashtags);
        },
        onError: setFailure,
      },
    );
  };

  const handleGenerateCaption = () => runGenerateCaption(null);

  const runGenerateImage = (tweak?: string | null) => {
    if (!prompt.trim()) return;
    haptic();
    setError(null);
    setQuotaHit(false);
    setSaved(false);
    setAttachedTitle(null);
    setImageTweak(tweak ?? null);
    const tweakInstruction = tweak ? ` ${IMAGE_TWEAKS.find((t) => t.label === tweak)?.instruction ?? ""}` : "";
    genImage.mutate(
      { data: { prompt: `${prompt.trim()}${tweakInstruction}`, size: imageSize, brandKitId } },
      {
        onSuccess: (res) => {
          track("image_generated", { size: imageSize });
          trackFeatureUse("studio_image");
          setImageB64(res.b64Json);
          setImagePath(res.imagePath);
        },
        onError: setFailure,
      },
    );
  };

  const handleGenerateImage = () => runGenerateImage(null);

  const handleSave = () => {
    if (!caption && !imagePath) return;
    haptic();
    setError(null);
    setQuotaHit(false);
    const fullCaption = [caption, hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")]
      .filter(Boolean)
      .join("\n\n");
    createContent.mutate(
      {
        data: {
          title: prompt.trim().slice(0, 80) || "Untitled post",
          caption: fullCaption,
          imagePath: imagePath ?? undefined,
          imagePrompt: imagePath ? prompt.trim() : undefined,
          platform,
          contentType: imagePath ? "image" : "text",
          status: "draft",
          brandKitId,
        },
      },
      {
        onSuccess: () => {
          track("content_saved", {});
          setSaved(true);
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        },
        onError: setFailure,
      },
    );
  };

  const handleAttachPress = (item: ContentItem) => {
    if (!imagePath || attachingId !== null) return;
    if (item.imagePath) {
      haptic();
      setReplaceTarget(item);
      return;
    }
    doAttach(item);
  };

  const doAttach = (item: ContentItem) => {
    if (!imagePath || attachingId !== null) return;
    haptic();
    setReplaceTarget(null);
    setError(null);
    setAttachingId(item.id);
    updateContent.mutate(
      {
        id: item.id,
        data: {
          imagePath,
          imagePrompt: prompt.trim() || undefined,
          contentType: "image",
        },
      },
      {
        onSuccess: () => {
          setAttachingId(null);
          setAttachOpen(false);
          setAttachedTitle(item.title);
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetContentQueryKey(item.id) });
        },
        onError: (err) => {
          setAttachingId(null);
          setAttachOpen(false);
          setFailure(err);
        },
      },
    );
  };

  const imagePending = genImage.isPending;
  const aspectRatio =
    imageSize === "1536x1024" ? 1536 / 1024 : imageSize === "1024x1536" ? 1024 / 1536 : 1;

  return (
    <>
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: c.background }}
        contentContainerStyle={{
          paddingTop: insets.top + 20,
          paddingBottom: insets.bottom + 110,
          paddingHorizontal: 20,
        }}
      >
        <Text style={styles.title}>AI Studio</Text>
        <Text style={styles.subtitle}>
          Generate on-brand captions and images for your next post
        </Text>

        <Card style={{ marginTop: 18 }}>
          <Text style={styles.cardTitle}>Need ideas?</Text>
          <View style={styles.ideaRow}>
            <Input
              value={niche}
              onChangeText={setNiche}
              placeholder="Your niche, e.g. fitness coaching"
              style={{ flex: 1 }}
            />
            <Button
              title="Ideas"
              variant="secondary"
              onPress={handleSuggest}
              loading={suggest.isPending}
              disabled={!niche.trim()}
            />
          </View>
          {ideas.length > 0 ? (
            <View style={{ marginTop: 12, gap: 8 }}>
              {ideas.map((idea) => (
                <Chip
                  key={idea}
                  label={idea}
                  selected={prompt === idea}
                  onPress={() => setPrompt(idea)}
                />
              ))}
            </View>
          ) : null}
        </Card>

        <Label>What do you want to post about?</Label>
        <Input
          value={prompt}
          onChangeText={(t) => {
            setPrompt(t);
            setSaved(false);
          }}
          placeholder="e.g. Announcing our new summer collection"
          multiline
        />
        <View style={{ marginTop: 8, alignSelf: "flex-start" }}>
          <VoiceNoteButton
            onTranscript={(text) => {
              setPrompt((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
              setSaved(false);
              setVoiceErr(null);
            }}
            onError={(msg) => setVoiceErr(msg)}
          />
        </View>
        {voiceErr ? <Text style={styles.voiceError}>{voiceErr}</Text> : null}

        {kits.length > 0 ? (
          <>
            <Label>Brand</Label>
            <View style={styles.chipRow}>
              <Chip
                label="Auto"
                selected={brandKitId === null}
                onPress={() => setBrandKitId(null)}
              />
              {kits.map((kit) => (
                <BrandChip
                  key={kit.id}
                  label={kit.isDefault ? `${kit.name} (default)` : kit.name}
                  swatches={kitSwatches(kit)}
                  selected={brandKitId === kit.id}
                  onPress={() => setBrandKitId(kit.id)}
                />
              ))}
            </View>
            <Text style={styles.hint}>
              Auto uses your default brand. Captions and images follow the selected brand's
              colors, style and voice.
            </Text>
          </>
        ) : null}

        <Label>Platform</Label>
        <View style={styles.chipRow}>
          {PLATFORMS.map((p) => (
            <Chip key={p} label={p} selected={platform === p} onPress={() => setPlatform(p)} />
          ))}
        </View>

        <Label>Tone</Label>
        <View style={styles.chipRow}>
          {TONES.map((t) => (
            <Chip key={t} label={t} selected={tone === t} onPress={() => setTone(t)} />
          ))}
        </View>

        <Label>Image size</Label>
        <View style={styles.chipRow}>
          {IMAGE_SIZES.map((s) => (
            <Chip
              key={s.value}
              label={s.label}
              selected={imageSize === s.value}
              onPress={() => setImageSize(s.value)}
            />
          ))}
        </View>

        {activeKit && activeSwatches.length > 0 ? (
          <View style={styles.paletteRow}>
            <Text style={styles.paletteLabel} numberOfLines={1}>
              Generating for {activeKit.name}
            </Text>
            <SwatchStrip hexes={activeSwatches} size={14} />
          </View>
        ) : null}

        <View style={styles.actionRow}>
          <Button
            title="Generate caption"
            icon="type"
            onPress={handleGenerateCaption}
            loading={genCaption.isPending}
            disabled={!prompt.trim()}
            style={{ flex: 1 }}
          />
          <Button
            title="Image"
            icon="image"
            variant="outline"
            onPress={handleGenerateImage}
            loading={imagePending}
            disabled={!prompt.trim()}
          />
        </View>

        {error ? (
          <View style={[styles.errorBox, quotaHit && styles.quotaBox]}>
            <Feather
              name={quotaHit ? "zap-off" : "alert-circle"}
              size={16}
              color={quotaHit ? c.accentForeground : c.destructive}
            />
            <Text style={[styles.errorText, quotaHit && styles.quotaText]}>{error}</Text>
          </View>
        ) : null}

        {caption ? (
          <Card style={{ marginTop: 18 }}>
            <Text style={styles.cardTitle}>Caption</Text>
            <Text style={styles.captionText}>{caption}</Text>
            <CaptionSplitHints text={caption} platform={platform} />
            {hashtags.length > 0 ? (
              <Text style={styles.hashtags}>
                {hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}
              </Text>
            ) : null}
            <View style={styles.chipRow2}>
              {CAPTION_TWEAKS.map((t) => (
                <Chip
                  key={t.label}
                  label={t.label}
                  selected={captionTweak === t.label}
                  onPress={() => runGenerateCaption(t.label)}
                />
              ))}
            </View>
            <Button
              title="Regenerate"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => runGenerateCaption(null)}
              loading={genCaption.isPending}
              disabled={!prompt.trim()}
              style={{ marginTop: 10 }}
            />
          </Card>
        ) : null}

        {imagePending ? (
          <Card style={{ marginTop: 12, padding: 8 }}>
            <View style={[styles.imagePlaceholder, { aspectRatio }]}>
              <ActivityIndicator size="small" color={c.primary} />
              <Text style={styles.placeholderText}>Generating your image…</Text>
            </View>
          </Card>
        ) : imageB64 ? (
          <Card style={{ marginTop: 12, padding: 8 }}>
            <Image
              source={{ uri: `data:image/png;base64,${imageB64}` }}
              style={[styles.image, { aspectRatio }]}
              contentFit="cover"
            />
            <View style={styles.chipRow2}>
              {IMAGE_TWEAKS.map((t) => (
                <Chip
                  key={t.label}
                  label={t.label}
                  selected={imageTweak === t.label}
                  onPress={() => runGenerateImage(t.label)}
                />
              ))}
            </View>
            <View style={styles.imageActions}>
              <Button
                title="Regenerate"
                icon="refresh-cw"
                variant="secondary"
                onPress={handleGenerateImage}
                disabled={!prompt.trim()}
                style={{ flex: 1 }}
              />
              <Button
                title="Attach to post"
                icon="paperclip"
                variant="outline"
                onPress={() => setAttachOpen(true)}
                disabled={!imagePath}
                style={{ flex: 1 }}
              />
            </View>
            {attachedTitle ? (
              <View style={styles.attachedRow}>
                <Feather name="check-circle" size={15} color={c.success} />
                <Text style={styles.attachedText} numberOfLines={1}>
                  Attached to "{attachedTitle}"
                </Text>
              </View>
            ) : null}
          </Card>
        ) : null}

        {caption || imagePath ? (
          saved ? (
            <View style={styles.savedRow}>
              <Feather name="check-circle" size={18} color={c.success} />
              <Text style={styles.savedText}>Saved to your content library</Text>
            </View>
          ) : (
            <Button
              title="Save to library"
              icon="save"
              onPress={handleSave}
              loading={createContent.isPending}
              style={{ marginTop: 16 }}
            />
          )
        ) : null}
      </KeyboardAwareScrollViewCompat>

      <Modal
        visible={attachOpen}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setReplaceTarget(null);
          setAttachOpen(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {replaceTarget ? "Replace existing image?" : "Attach image to a post"}
              </Text>
              <Pressable
                onPress={() => {
                  setReplaceTarget(null);
                  setAttachOpen(false);
                }}
                hitSlop={10}
                disabled={attachingId !== null}
              >
                <Feather name="x" size={22} color={c.mutedForeground} />
              </Pressable>
            </View>
            {replaceTarget ? (
              <View>
                <Text style={styles.modalSubtitle}>
                  "{replaceTarget.title}" already has an image. Attaching will permanently
                  replace it with the new one.
                </Text>
                {replaceTarget.imagePath ? (
                  <View style={styles.replacePreview}>
                    <ContentImage
                      imagePath={replaceTarget.imagePath}
                      style={styles.replaceThumb}
                    />
                    <Text style={styles.replacePreviewLabel}>Current image</Text>
                  </View>
                ) : null}
                <Button
                  title="Replace image"
                  onPress={() => doAttach(replaceTarget)}
                  loading={attachingId === replaceTarget.id}
                  style={{ marginTop: 16 }}
                />
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setReplaceTarget(null)}
                  disabled={attachingId !== null}
                  style={{ marginTop: 10 }}
                />
              </View>
            ) : (
              <>
            <Text style={styles.modalSubtitle}>
              The generated image will replace the selected post's current image.
            </Text>
            {contentList.isLoading ? (
              <View style={{ gap: 10, marginTop: 16 }}>
                <Skeleton height={56} />
                <Skeleton height={56} />
                <Skeleton height={56} />
              </View>
            ) : contentList.isError ? (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.errorText}>Could not load your content library.</Text>
                <Button
                  title="Retry"
                  variant="secondary"
                  onPress={() => contentList.refetch()}
                  style={{ marginTop: 12 }}
                />
              </View>
            ) : (contentList.data ?? []).length === 0 ? (
              <EmptyState
                icon="folder"
                title="No posts yet"
                subtitle="Save this image to your library instead, or create a post first."
              />
            ) : (
              <FlatList
                data={contentList.data ?? []}
                keyExtractor={(item) => String(item.id)}
                style={{ marginTop: 12 }}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => handleAttachPress(item)}
                    disabled={attachingId !== null}
                    style={({ pressed }) => [
                      styles.attachItem,
                      { opacity: pressed || (attachingId !== null && attachingId !== item.id) ? 0.6 : 1 },
                    ]}
                  >
                    <View style={{ flex: 1, marginRight: 10 }}>
                      <Text style={styles.attachItemTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.attachItemMeta}>
                        {item.platform} · {item.status}
                        {item.imagePath ? " · has image" : ""}
                      </Text>
                    </View>
                    {attachingId === item.id ? (
                      <ActivityIndicator size="small" color={c.primary} />
                    ) : (
                      <Feather name="chevron-right" size={18} color={c.mutedForeground} />
                    )}
                  </Pressable>
                )}
              />
            )}
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.bold, fontSize: 24, color: c.foreground },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: 4,
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  ideaRow: { flexDirection: "row", gap: 10, marginTop: 10, alignItems: "center" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 8,
    lineHeight: 17,
  },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 22 },
  brandChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  brandChipText: { fontFamily: fonts.medium, fontSize: 13 },
  paletteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: colors.radius,
    backgroundColor: c.muted,
  },
  paletteLabel: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.mutedForeground,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 12,
    padding: 12,
    borderRadius: colors.radius,
    backgroundColor: "#fdecec",
  },
  quotaBox: { backgroundColor: c.accent },
  errorText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.destructive,
    lineHeight: 19,
  },
  quotaText: { color: c.accentForeground },
  voiceError: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.destructive,
    marginTop: 6,
  },
  captionText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.foreground,
    marginTop: 8,
    lineHeight: 21,
  },
  hashtags: { fontFamily: fonts.medium, fontSize: 13, color: c.primary, marginTop: 10 },
  chipRow2: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  image: { width: "100%", borderRadius: colors.radius },
  imagePlaceholder: {
    width: "100%",
    borderRadius: colors.radius,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  placeholderText: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  imageActions: { flexDirection: "row", gap: 10, marginTop: 10 },
  attachedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  attachedText: { fontFamily: fonts.medium, fontSize: 13, color: c.success, flex: 1 },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    paddingVertical: 12,
  },
  savedText: { fontFamily: fonts.semiBold, fontSize: 14, color: c.success },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: c.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
    maxHeight: "75%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalTitle: { fontFamily: fonts.bold, fontSize: 17, color: c.foreground },
  modalSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: 6,
    lineHeight: 19,
  },
  attachItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  attachItemTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  replacePreview: { marginTop: 14, alignItems: "flex-start", gap: 6 },
  replaceThumb: { width: 96, height: 96, borderRadius: 12 },
  replacePreviewLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
  },
  attachItemMeta: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
});
