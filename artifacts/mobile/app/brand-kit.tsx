import { Feather } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBrandKits,
  useGetBrandKit,
  useCreateBrandKitVersion,
  useSetDefaultBrandKit,
  getListBrandKitsQueryKey,
  getGetBrandKitQueryKey,
  type BrandKitPayload,
} from "@workspace/api-client-react";

import { Button, Card, Chip, EmptyState, ErrorState, Label, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { haptic } from "@/lib/haptics";

const c = colors.light;

/** Split a comma-separated string into a trimmed array, dropping blanks. */
function commaList(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Split a newline-separated string into a trimmed array, dropping blanks. */
function lineList(s: string): string[] {
  return s
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Local edit state type — mirrors the fields exposed in the form
// ---------------------------------------------------------------------------
interface EditState {
  brandName: string;
  tagline: string;
  description: string;
  industry: string;
  audience: string; // comma-separated
  traits: string; // comma-separated
  dos: string; // newline-separated
  donts: string; // newline-separated
  captionStyle: string;
}

export function payloadToEdit(payload: BrandKitPayload): EditState {
  return {
    brandName: payload.identity.brand_name ?? "",
    tagline: payload.identity.tagline ?? "",
    description: payload.identity.description ?? "",
    industry: payload.identity.industry ?? "",
    audience: (payload.identity.audience ?? []).join(", "),
    traits: (payload.voice.traits ?? []).join(", "),
    dos: (payload.voice.dos ?? []).join("\n"),
    donts: (payload.voice.donts ?? []).join("\n"),
    captionStyle: payload.voice.caption_style ?? "",
  };
}

export function applyEditToPayload(base: BrandKitPayload, edit: EditState): BrandKitPayload {
  // Deep-clone so every other section (colors, typography, logos…) is
  // preserved verbatim. Only identity and voice sections change.
  const clone = JSON.parse(JSON.stringify(base)) as BrandKitPayload;
  clone.identity = {
    ...clone.identity,
    brand_name: edit.brandName.trim(),
    tagline: edit.tagline.trim(),
    description: edit.description.trim(),
    industry: edit.industry.trim(),
    audience: commaList(edit.audience),
  };
  clone.voice = {
    ...clone.voice,
    traits: commaList(edit.traits),
    dos: lineList(edit.dos),
    donts: lineList(edit.donts),
    caption_style: edit.captionStyle.trim(),
  };
  return clone;
}

export function isDirty(current: EditState, original: EditState): boolean {
  return (Object.keys(current) as (keyof EditState)[]).some(
    (k) => current[k] !== original[k],
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function BrandKitScreen() {
  const queryClient = useQueryClient();

  const kitsQuery = useListBrandKits(undefined, {
    query: { queryKey: getListBrandKitsQueryKey() },
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
  const activePayload = detail?.activeVersion?.payload ?? null;

  // ----- local edit state -----
  const [edit, setEdit] = useState<EditState | null>(null);
  const [original, setOriginal] = useState<EditState | null>(null);

  // Seed (or re-seed) form whenever the active payload changes.
  useEffect(() => {
    if (activePayload) {
      const e = payloadToEdit(activePayload);
      setEdit(e);
      setOriginal(e);
    } else {
      setEdit(null);
      setOriginal(null);
    }
  }, [activePayload]);

  const dirty = edit !== null && original !== null && isDirty(edit, original);

  const createVersion = useCreateBrandKitVersion();
  const setDefault = useSetDefaultBrandKit();
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  // Clear notice when kit changes.
  useEffect(() => {
    setNotice(null);
  }, [kitId]);

  const afterSave = () => {
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
    if (kitId !== null) {
      queryClient.invalidateQueries({ queryKey: getGetBrandKitQueryKey(kitId) });
    }
  };

  const selectedKitIsDefault = kitId !== null && kits.find((k) => k.id === kitId)?.isDefault === true;

  const handleSetDefault = () => {
    haptic();
    if (kitId === null) return;
    setDefault.mutate(
      { id: kitId },
      {
        onSuccess: () => {
          setNotice({ kind: "info", text: "Default brand kit updated." });
          queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
        },
        onError: (err) => {
          setNotice({
            kind: "error",
            text: apiErrorMessage(err, "Could not set default brand kit."),
          });
        },
      },
    );
  };

  const handleSave = () => {
    haptic();
    if (kitId === null || !activePayload || !edit) return;
    const payload = applyEditToPayload(activePayload, edit);
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
          setNotice({ kind: "info", text: "Brand kit saved." });
          // After successful save the new payload will arrive via the query
          // invalidation; dirty state will reset via the useEffect above.
          afterSave();
        },
        onError: (err) => {
          setNotice({
            kind: "error",
            text: apiErrorMessage(err, "Could not save the brand kit."),
          });
        },
      },
    );
  };

  // ----- loading / error guards -----
  if (kitsQuery.isLoading) {
    return (
      <View style={styles.pad}>
        <Skeleton height={90} />
        <Skeleton height={160} style={{ marginTop: 12 }} />
        <Skeleton height={200} style={{ marginTop: 12 }} />
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
          icon="layers"
          title="No brand kits yet"
          subtitle="Complete the onboarding interview and a Brand Kit will be created automatically."
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      {/* Kit selector — only shown when there are multiple kits */}
      {kits.length > 1 ? (
        <>
          <Label>Brand</Label>
          <View style={styles.chipRow}>
            {kits.map((kit) => (
              <Chip
                key={kit.id}
                label={kit.isDefault ? `${kit.name} (default)` : kit.name}
                selected={kitId === kit.id}
                onPress={() => {
                  haptic();
                  setSelectedKitId(kit.id);
                }}
              />
            ))}
          </View>
          {!selectedKitIsDefault && (
            <Button
              title={setDefault.isPending ? "Setting default…" : "Set as default"}
              disabled={setDefault.isPending}
              loading={setDefault.isPending}
              onPress={handleSetDefault}
              testID="btn-set-default"
            />
          )}
        </>
      ) : null}

      {/* Identity section */}
      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.iconWrap}>
            <Feather name="layers" size={16} color={c.primary} />
          </View>
          <Text style={styles.cardTitle}>Identity</Text>
        </View>

        {detailQuery.isLoading || edit === null ? (
          <Skeleton height={220} />
        ) : (
          <>
            <Label>Brand name</Label>
            <TextInput
              value={edit.brandName}
              onChangeText={(v) => setEdit((s) => s && { ...s, brandName: v })}
              placeholder="Your brand name"
              placeholderTextColor={c.mutedForeground}
              style={styles.input}
              testID="input-brand-name"
            />

            <Label>Tagline</Label>
            <TextInput
              value={edit.tagline}
              onChangeText={(v) => setEdit((s) => s && { ...s, tagline: v })}
              placeholder="One-line description"
              placeholderTextColor={c.mutedForeground}
              style={styles.input}
              testID="input-tagline"
            />

            <Label>Description</Label>
            <TextInput
              value={edit.description}
              onChangeText={(v) => setEdit((s) => s && { ...s, description: v })}
              placeholder="What your brand does"
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.multilineInput]}
              multiline
              numberOfLines={3}
              testID="input-description"
            />

            <Label>Industry</Label>
            <TextInput
              value={edit.industry}
              onChangeText={(v) => setEdit((s) => s && { ...s, industry: v })}
              placeholder="e.g. Fashion, SaaS, Food & Beverage"
              placeholderTextColor={c.mutedForeground}
              style={styles.input}
              testID="input-industry"
            />

            <Label>Target audience</Label>
            <Text style={styles.hint}>Comma-separated list</Text>
            <TextInput
              value={edit.audience}
              onChangeText={(v) => setEdit((s) => s && { ...s, audience: v })}
              placeholder="e.g. young professionals, home cooks"
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.multilineInput]}
              multiline
              numberOfLines={2}
              testID="input-audience"
            />
          </>
        )}
      </Card>

      {/* Voice section */}
      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.iconWrap}>
            <Feather name="message-circle" size={16} color={c.primary} />
          </View>
          <Text style={styles.cardTitle}>Brand voice</Text>
        </View>

        {detailQuery.isLoading || edit === null ? (
          <Skeleton height={300} />
        ) : (
          <>
            <Label>Personality traits</Label>
            <Text style={styles.hint}>Comma-separated list</Text>
            <TextInput
              value={edit.traits}
              onChangeText={(v) => setEdit((s) => s && { ...s, traits: v })}
              placeholder="e.g. bold, friendly, witty"
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.multilineInput]}
              multiline
              numberOfLines={2}
              testID="input-traits"
            />

            <Label>Dos</Label>
            <Text style={styles.hint}>One per line</Text>
            <TextInput
              value={edit.dos}
              onChangeText={(v) => setEdit((s) => s && { ...s, dos: v })}
              placeholder={"Use inclusive language\nSpeak directly to the reader"}
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.multilineInput]}
              multiline
              numberOfLines={3}
              testID="input-dos"
            />

            <Label>Don'ts</Label>
            <Text style={styles.hint}>One per line</Text>
            <TextInput
              value={edit.donts}
              onChangeText={(v) => setEdit((s) => s && { ...s, donts: v })}
              placeholder={"Use jargon\nMake unverified claims"}
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.multilineInput]}
              multiline
              numberOfLines={3}
              testID="input-donts"
            />

            <Label>Caption style</Label>
            <TextInput
              value={edit.captionStyle}
              onChangeText={(v) => setEdit((s) => s && { ...s, captionStyle: v })}
              placeholder="e.g. short and punchy, always ends with a question"
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.multilineInput]}
              multiline
              numberOfLines={2}
              testID="input-caption-style"
            />
          </>
        )}
      </Card>

      {/* Save button */}
      <Button
        title={createVersion.isPending ? "Saving..." : "Save brand kit"}
        disabled={!dirty || createVersion.isPending || !activePayload}
        loading={createVersion.isPending}
        onPress={handleSave}
      />

      {notice ? (
        <Text
          style={[styles.notice, notice.kind === "error" && styles.noticeError]}
          testID="text-brand-kit-notice"
        >
          {notice.text}
        </Text>
      ) : null}

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
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: -6,
    marginBottom: 2,
  },
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
    marginBottom: 4,
  },
  multilineInput: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  notice: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  noticeError: { color: c.destructive },
});
