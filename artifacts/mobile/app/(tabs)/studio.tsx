import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useCreateContent,
  useGenerateCaption,
  useGenerateImage,
  useSuggestTopics,
  getListContentQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Button, Card, Chip, Input, Label } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const PLATFORMS = ["instagram", "facebook", "linkedin", "x", "threads"];
const TONES = ["Friendly", "Professional", "Witty", "Bold", "Inspirational"];

function errorMessage(err: unknown): string {
  const anyErr = err as { status?: number; message?: string };
  if (anyErr?.status === 402) {
    return "You have reached your monthly AI quota. Upgrade your plan on the web app to continue.";
  }
  return anyErr?.message || "Something went wrong. Please try again.";
}

export default function StudioScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState("instagram");
  const [tone, setTone] = useState("Friendly");
  const [niche, setNiche] = useState("");
  const [ideas, setIdeas] = useState<string[]>([]);
  const [caption, setCaption] = useState<string | null>(null);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const genCaption = useGenerateCaption();
  const genImage = useGenerateImage();
  const suggest = useSuggestTopics();
  const createContent = useCreateContent();

  const haptic = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleSuggest = () => {
    if (!niche.trim()) return;
    setError(null);
    suggest.mutate(
      { data: { niche: niche.trim() } },
      {
        onSuccess: (res) => setIdeas(res.ideas),
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const handleGenerateCaption = () => {
    if (!prompt.trim()) return;
    haptic();
    setError(null);
    setSaved(false);
    genCaption.mutate(
      { data: { prompt: prompt.trim(), platform, tone } },
      {
        onSuccess: (res) => {
          setCaption(res.caption);
          setHashtags(res.hashtags);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const handleGenerateImage = () => {
    if (!prompt.trim()) return;
    haptic();
    setError(null);
    setSaved(false);
    genImage.mutate(
      { data: { prompt: prompt.trim(), size: "1024x1024" } },
      {
        onSuccess: (res) => {
          setImageB64(res.b64Json);
          setImagePath(res.imagePath);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const handleSave = () => {
    if (!caption && !imagePath) return;
    haptic();
    setError(null);
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
        },
      },
      {
        onSuccess: () => {
          setSaved(true);
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
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
          loading={genImage.isPending}
          disabled={!prompt.trim()}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {caption ? (
        <Card style={{ marginTop: 18 }}>
          <Text style={styles.cardTitle}>Caption</Text>
          <Text style={styles.captionText}>{caption}</Text>
          {hashtags.length > 0 ? (
            <Text style={styles.hashtags}>
              {hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {imageB64 ? (
        <Card style={{ marginTop: 12, padding: 8 }}>
          <Image
            source={{ uri: `data:image/png;base64,${imageB64}` }}
            style={styles.image}
            contentFit="cover"
          />
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
  actionRow: { flexDirection: "row", gap: 10, marginTop: 22 },
  error: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.destructive,
    marginTop: 12,
    lineHeight: 19,
  },
  captionText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.foreground,
    marginTop: 8,
    lineHeight: 21,
  },
  hashtags: { fontFamily: fonts.medium, fontSize: 13, color: c.primary, marginTop: 10 },
  image: { width: "100%", aspectRatio: 1, borderRadius: colors.radius },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    paddingVertical: 12,
  },
  savedText: { fontFamily: fonts.semiBold, fontSize: 14, color: c.success },
});
