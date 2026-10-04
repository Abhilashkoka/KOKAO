import { Feather } from "@expo/vector-icons";
import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { Character, PresetCharacter, VideoModelInfo } from "@workspace/api-client-react";

import { CharacterLikenessConsent } from "@/components/CharacterLikenessConsent";
import { Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { haptic } from "@/lib/haptics";
import type { PickedDirectedFile } from "@/lib/directedUpload";
import {
  DIRECTED_MAX_ASSETS,
  DIRECTED_MAX_OVERLAYS,
  DIRECTED_OVERLAY_MAX_CHARS,
  DIRECTED_RECORDING_AUDIO_NOTICE,
  classifyDirectedFile,
  directedCastReadiness,
  directedEndingDisclosure,
  parseDirectedSeconds,
  type DirectedBrandOptions,
  type DirectedCastSelection,
  type DirectedDraft,
} from "@/lib/directedVideo";

const c = colors.light;

export type DirectedVideoPanelProps = {
  draft: DirectedDraft;
  onChange: (update: (prev: DirectedDraft) => DirectedDraft) => void;
  onToggle: (enabled: boolean) => void;
  /** Compatible Wan models only (already filtered for the cast mode). */
  models: VideoModelInfo[];
  modelsLoading: boolean;
  modelId: string | null;
  onModelChange: (id: string) => void;
  durationSec: number;
  onDurationChange: (sec: number) => void;
  savedCharacters: Character[];
  presetCharacters: PresetCharacter[];
  cast: DirectedCastSelection;
  onCastChange: (cast: DirectedCastSelection) => void;
  onCreateCharacter: () => void;
  castRestriction: string | null;
  brandKits: { id: number; name: string }[] | undefined;
  brandKitId: number | null;
  onBrandKitChange: (id: number | null) => void;
  brand: DirectedBrandOptions;
  brandLoading: boolean;
  pickFiles: (limit: number) => Promise<PickedDirectedFile[]>;
  uploadFile: (file: PickedDirectedFile) => Promise<string>;
  onUploadStart: () => void;
  onUploadEnd: () => void;
  blockReason: string | null;
};

function Option({
  label,
  selected,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        haptic();
        onPress();
      }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.8 },
      ]}
      testID={testID}
    >
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({
  label,
  icon,
  onPress,
  disabled,
  testID,
  tone = "default",
  accessibilityLabel,
}: {
  label?: string;
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
  tone?: "default" | "destructive";
  accessibilityLabel?: string;
}) {
  const color = tone === "destructive" ? c.destructive : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.smallButton,
        !label && styles.iconButton,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
      ]}
      testID={testID}
    >
      <Feather name={icon} size={14} color={color} />
      {label ? <Text style={[styles.smallButtonText, { color }]}>{label}</Text> : null}
    </Pressable>
  );
}

function TimeField({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testID: string;
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  return (
    <View style={{ gap: 3 }}>
      <Text style={styles.fieldLabel}>{label} (s)</Text>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          onChange(parseDirectedSeconds(t));
        }}
        keyboardType="decimal-pad"
        inputMode="decimal"
        accessibilityLabel={`${label} seconds`}
        style={styles.timeInput}
        testID={testID}
      />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function DirectedVideoPanel(props: DirectedVideoPanelProps) {
  const { draft, onChange, durationSec, brand } = props;
  const retryFiles = useRef(new Map<string, PickedDirectedFile>());
  const picking = useRef(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const hasSelectedCast = props.cast.kind !== "none";
  const selectedSaved =
    props.cast.kind === "saved"
      ? props.savedCharacters.find((ch) => props.cast.kind === "saved" && ch.id === props.cast.characterId) ?? null
      : null;
  const selectedModel = props.models.find((m) => m.id === props.modelId) ?? null;
  const anyLogo = brand.logos.primary || brand.logos.secondary || brand.logos.icon_mark;
  const endingNote = directedEndingDisclosure(draft.ending, brand, durationSec);

  const patchAsset = (key: string, patch: Partial<DirectedDraft["assets"][number]>) =>
    onChange((d) => ({
      ...d,
      assets: d.assets.map((a) => (a.key === key ? { ...a, ...patch } : a)),
    }));
  const patchOverlay = (key: string, patch: Partial<DirectedDraft["overlays"][number]>) =>
    onChange((d) => ({
      ...d,
      overlays: d.overlays.map((o) => (o.key === key ? { ...o, ...patch } : o)),
    }));

  const startUpload = (key: string, file: PickedDirectedFile) => {
    props.onUploadStart();
    patchAsset(key, { status: "uploading", error: undefined });
    props
      .uploadFile(file)
      .then((objectPath) => {
        retryFiles.current.delete(key);
        patchAsset(key, { status: "ready", objectPath });
      })
      .catch((err: unknown) => {
        patchAsset(key, {
          status: "failed",
          error: err instanceof Error ? err.message : "Upload failed",
        });
      })
      .finally(props.onUploadEnd);
  };

  const addFiles = async () => {
    if (picking.current) return;
    picking.current = true;
    setPickError(null);
    const room = DIRECTED_MAX_ASSETS - draft.assets.length;
    let files: PickedDirectedFile[] = [];
    try {
      files = await props.pickFiles(room);
    } catch {
      setPickError("Could not open the file picker. Try again.");
      return;
    } finally {
      picking.current = false;
    }
    files.slice(0, Math.max(0, room)).forEach((file) => {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const check = classifyDirectedFile(file);
      onChange((d) => ({
        ...d,
        assets: [
          ...d.assets,
          {
            key,
            name: file.name,
            kind: "kind" in check ? check.kind : "image",
            status: "error" in check ? "failed" : "uploading",
            error: "error" in check ? check.error : undefined,
            objectPath: null,
            startSec: 0,
            endSec: Math.min(durationSec, 2),
            placement: "corner",
          },
        ],
      }));
      if ("kind" in check) {
        retryFiles.current.set(key, file);
        startUpload(key, file);
      }
    });
  };

  return (
    <View style={styles.panel} testID="panel-directed-video">
      <View style={styles.toggleRow}>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={styles.titleRow}>
            <Feather name="film" size={14} color={c.primary} />
            <Text style={styles.title}>Let KOKAO direct it (optional)</Text>
          </View>
          <Text style={styles.hint}>
            One video generation, then your exact text, assets and brand ending are added on
            top. Storyboard review is off while this is on.
          </Text>
          <Text style={styles.hint} testID="text-directed-audio-notice">
            AI direction and video generation use credits. Real-person characters need approved
            references and permission for the selected provider. {DIRECTED_RECORDING_AUDIO_NOTICE}
          </Text>
        </View>
        <Switch
          value={draft.enabled}
          onValueChange={(v) => {
            haptic();
            props.onToggle(v);
          }}
          trackColor={{ true: c.primary, false: c.border }}
          accessibilityLabel="Let KOKAO direct this video"
          testID="switch-directed-video"
        />
      </View>

      {draft.enabled ? (
        <View style={{ gap: 14 }}>
          <Section title="Character">
            <View style={styles.wrapRow}>
              <Option
                label="None"
                selected={props.cast.kind === "none"}
                onPress={() => props.onCastChange({ kind: "none" })}
                testID="option-directed-cast-none"
              />
              {props.savedCharacters.map((ch) => (
                <Option
                  key={`s-${ch.id}`}
                  label={ch.name}
                  selected={props.cast.kind === "saved" && props.cast.characterId === ch.id}
                  onPress={() =>
                    props.onCastChange({ kind: "saved", characterId: ch.id, outfitId: null })
                  }
                  testID={`option-directed-cast-saved-${ch.id}`}
                />
              ))}
              {props.presetCharacters.map((p) => (
                <Option
                  key={`p-${p.id}`}
                  label={`${p.name} (preset)`}
                  selected={props.cast.kind === "preset" && props.cast.presetCharacterId === String(p.id)}
                  onPress={() => props.onCastChange({ kind: "preset", presetCharacterId: String(p.id) })}
                  testID={`option-directed-cast-preset-${p.id}`}
                />
              ))}
            </View>
            <SmallButton
              label="Create a character"
              icon="user-plus"
              onPress={props.onCreateCharacter}
              testID="button-directed-create-character"
            />
            {selectedSaved ? (
              <Text
                style={directedCastReadiness(selectedSaved) ? styles.error : styles.hint}
                testID="text-directed-cast-readiness"
              >
                {directedCastReadiness(selectedSaved) ??
                  "Approved reference sheet and outfit are sent directly as references."}
              </Text>
            ) : props.cast.kind === "preset" ? (
              <Text style={styles.hint}>
                The preset's approved reference and signature outfit are sent as references.
              </Text>
            ) : null}
            {selectedSaved && (selectedSaved.referenceSource === "uploaded" || selectedSaved.provenanceStatus === "uploaded") ? (
              <CharacterLikenessConsent characterId={selectedSaved.id} />
            ) : null}
            {!hasSelectedCast ? (
              <View style={{ gap: 4 }}>
                <Text style={styles.fieldLabel}>Fictional actor (optional)</Text>
                <TextInput
                  multiline
                  maxLength={1500}
                  value={draft.fictionalCharacter}
                  onChangeText={(t) => onChange((d) => ({ ...d, fictionalCharacter: t }))}
                  placeholder="A woman in her thirties, short grey hair, linen apron, calm and direct"
                  placeholderTextColor={c.mutedForeground}
                  style={styles.textArea}
                  testID="input-directed-fictional"
                />
              </View>
            ) : null}
          </Section>

          <Section title="Model">
            {props.castRestriction ? (
              <Text style={styles.error} testID="text-directed-cast-restriction">
                {props.castRestriction}
              </Text>
            ) : null}
            {props.modelsLoading ? (
              <Skeleton height={36} />
            ) : props.models.length === 0 ? (
              <Text style={styles.error} testID="text-directed-no-model">
                {hasSelectedCast
                  ? "With a character this needs Atlas Wan 3.0 Standard or Prime Reference, which is not configured."
                  : "Needs Atlas Wan 3.0 Standard or Prime Text-to-Video, which is not configured."}
              </Text>
            ) : (
              <>
                <View style={styles.wrapRow}>
                  {props.models.map((m) => (
                    <Option
                      key={m.id}
                      label={m.label}
                      selected={props.modelId === m.id}
                      onPress={() => props.onModelChange(m.id)}
                      testID={`option-directed-model-${m.id}`}
                    />
                  ))}
                </View>
                {selectedModel && selectedModel.durations.length > 0 ? (
                  <View style={styles.wrapRow}>
                    {selectedModel.durations.map((d) => (
                      <Option
                        key={d}
                        label={`${d}s`}
                        selected={durationSec === d}
                        onPress={() => props.onDurationChange(d)}
                        testID={`option-directed-duration-${d}`}
                      />
                    ))}
                  </View>
                ) : null}
              </>
            )}
          </Section>

          <Section title="Brand">
            <Text style={styles.fieldLabel}>Branding notes (optional)</Text>
            <TextInput
              multiline
              maxLength={3000}
              value={draft.brandingInstructions}
              onChangeText={(t) => onChange((d) => ({ ...d, brandingInstructions: t }))}
              placeholder="Teal and cream palette, product always label-forward"
              placeholderTextColor={c.mutedForeground}
              style={styles.textArea}
              testID="input-directed-branding"
            />
            <Text style={styles.fieldLabel}>Brand kit</Text>
            <View style={styles.wrapRow}>
              <Option
                label="No brand kit"
                selected={props.brandKitId === null}
                onPress={() => props.onBrandKitChange(null)}
                testID="option-directed-brand-kit-none"
              />
              {(props.brandKits ?? []).map((k) => (
                <Option
                  key={k.id}
                  label={k.name}
                  selected={props.brandKitId === k.id}
                  onPress={() => props.onBrandKitChange(k.id)}
                  testID={`option-directed-brand-kit-${k.id}`}
                />
              ))}
            </View>
            {props.brandKitId !== null && props.brandLoading ? <Skeleton height={56} /> : null}
            {props.brandKitId !== null && !props.brandLoading ? (
              <View style={{ gap: 8 }}>
                <Text style={styles.fieldLabel}>Add a brand ending?</Text>
                <View style={styles.wrapRow}>
                  <Option label="No ending" selected={draft.ending === "none"}
                    onPress={() => onChange((d) => ({ ...d, ending: "none" }))}
                    testID="option-directed-ending-none" />
                  <Option label={brand.logos.primary ? "Logo card" : "Logo card (no primary logo)"}
                    selected={draft.ending === "logo"} disabled={!brand.logos.primary}
                    onPress={() => onChange((d) => ({ ...d, ending: "logo" }))}
                    testID="option-directed-ending-logo" />
                  <Option label={brand.animation.available ? "Logo animation" : "Logo animation (not set up)"}
                    selected={draft.ending === "animation"} disabled={!brand.animation.available}
                    onPress={() => onChange((d) => ({ ...d, ending: "animation" }))}
                    testID="option-directed-ending-animation" />
                </View>
                {endingNote ? (
                  <Text style={styles.hint} testID="text-directed-ending-length">{endingNote}</Text>
                ) : null}
                <Text style={styles.fieldLabel}>Show a logo in the corner?</Text>
                <View style={styles.wrapRow}>
                  <Option label="No logo overlay" selected={draft.brandImage === "none"}
                    onPress={() => onChange((d) => ({ ...d, brandImage: "none" }))}
                    testID="option-directed-brand-image-none" />
                  <Option label="Primary" selected={draft.brandImage === "primary"} disabled={!brand.logos.primary}
                    onPress={() => onChange((d) => ({ ...d, brandImage: "primary" }))}
                    testID="option-directed-brand-image-primary" />
                  <Option label="Secondary" selected={draft.brandImage === "secondary"} disabled={!brand.logos.secondary}
                    onPress={() => onChange((d) => ({ ...d, brandImage: "secondary" }))}
                    testID="option-directed-brand-image-secondary" />
                  <Option label="Icon mark" selected={draft.brandImage === "icon_mark"} disabled={!brand.logos.icon_mark}
                    onPress={() => onChange((d) => ({ ...d, brandImage: "icon_mark" }))}
                    testID="option-directed-brand-image-icon_mark" />
                </View>
                {!anyLogo ? <Text style={styles.hint}>This kit has no logos yet.</Text> : null}
              </View>
            ) : null}
          </Section>

          <Section title={`Your assets (${draft.assets.length}/${DIRECTED_MAX_ASSETS})`}>
            <SmallButton
              label="Add file"
              icon="image"
              disabled={draft.assets.length >= DIRECTED_MAX_ASSETS}
              onPress={() => void addFiles()}
              testID="button-directed-add-asset"
            />
            {pickError ? <Text style={styles.error}>{pickError}</Text> : null}
            {draft.assets.length === 0 ? (
              <Text style={styles.hint} testID="text-directed-no-assets">
                No assets: KOKAO works from your brief and brand colours. An exact logo, product
                label, wording or app screen cannot be guaranteed from a prompt alone. Add the real
                file (PNG, JPEG, WebP up to 10 MB; MP4, WebM up to 40 MB) to place it exactly.
              </Text>
            ) : (
              draft.assets.map((a, i) => (
                <View key={a.key} style={styles.row} testID={`row-directed-asset-${i}`}>
                  <View style={styles.rowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{a.name}</Text>
                      <Text
                        style={a.status === "failed" ? styles.error : styles.hint}
                        testID={`status-directed-asset-${i}`}
                      >
                        {a.status === "uploading"
                          ? "Uploading"
                          : a.status === "failed"
                            ? (a.error ?? "Upload failed")
                            : a.kind === "video"
                              ? "Recording ready. Its audio is not used."
                              : "Image ready"}
                      </Text>
                    </View>
                    {a.status === "failed" && retryFiles.current.has(a.key) ? (
                      <SmallButton label="Retry" icon="refresh-cw"
                        onPress={() => {
                          const f = retryFiles.current.get(a.key);
                          if (f) startUpload(a.key, f);
                        }}
                        testID={`button-directed-asset-retry-${i}`} />
                    ) : null}
                    <SmallButton icon="x" tone="destructive"
                      accessibilityLabel={`Remove ${a.name}`}
                      disabled={a.status === "uploading"}
                      onPress={() => {
                        retryFiles.current.delete(a.key);
                        onChange((d) => ({ ...d, assets: d.assets.filter((x) => x.key !== a.key) }));
                      }}
                      testID={`button-directed-asset-remove-${i}`} />
                  </View>
                  <View style={styles.timeRow}>
                    <TimeField label="From" value={a.startSec}
                      onChange={(v) => patchAsset(a.key, { startSec: v })}
                      testID={`input-directed-asset-start-${i}`} />
                    <TimeField label="To" value={a.endSec}
                      onChange={(v) => patchAsset(a.key, { endSec: v })}
                      testID={`input-directed-asset-end-${i}`} />
                    <View style={{ flexDirection: "row", gap: 6, alignSelf: "flex-end" }}>
                      <Option label="Corner" selected={a.placement === "corner"}
                        onPress={() => patchAsset(a.key, { placement: "corner" })}
                        testID={`option-directed-asset-placement-corner-${i}`} />
                      <Option label="Full frame" selected={a.placement === "full_frame"}
                        onPress={() => patchAsset(a.key, { placement: "full_frame" })}
                        testID={`option-directed-asset-placement-full_frame-${i}`} />
                    </View>
                  </View>
                </View>
              ))
            )}
          </Section>

          <Section title={`Exact on-screen text (${draft.overlays.length}/${DIRECTED_MAX_OVERLAYS})`}>
            <SmallButton
              label="Add text"
              icon="type"
              disabled={draft.overlays.length >= DIRECTED_MAX_OVERLAYS}
              onPress={() =>
                onChange((d) => ({
                  ...d,
                  overlays: [
                    ...d.overlays,
                    { key: `${Date.now()}-${d.overlays.length}`, text: "", startSec: 0, endSec: Math.min(durationSec, 2) },
                  ],
                }))
              }
              testID="button-directed-add-text"
            />
            {draft.overlays.length === 0 ? (
              <Text style={styles.hint}>
                Text is drawn after generation, character for character. The video model never writes it.
              </Text>
            ) : null}
            {draft.overlays.map((o, i) => (
              <View key={o.key} style={styles.row} testID={`row-directed-text-${i}`}>
                <View style={styles.rowHeader}>
                  <TextInput
                    value={o.text}
                    maxLength={DIRECTED_OVERLAY_MAX_CHARS}
                    placeholder="Exact words to show"
                    placeholderTextColor={c.mutedForeground}
                    onChangeText={(t) => patchOverlay(o.key, { text: t })}
                    style={[styles.textArea, { flex: 1, minHeight: 40 }]}
                    testID={`input-directed-text-${i}`}
                  />
                  <SmallButton icon="x" tone="destructive"
                    accessibilityLabel={`Remove text ${i + 1}`}
                    onPress={() => onChange((d) => ({ ...d, overlays: d.overlays.filter((x) => x.key !== o.key) }))}
                    testID={`button-directed-text-remove-${i}`} />
                </View>
                <Text style={[styles.hint, { textAlign: "right" }]}>
                  {o.text.length}/{DIRECTED_OVERLAY_MAX_CHARS}
                </Text>
                <View style={styles.timeRow}>
                  <TimeField label="From" value={o.startSec}
                    onChange={(v) => patchOverlay(o.key, { startSec: v })}
                    testID={`input-directed-text-start-${i}`} />
                  <TimeField label="To" value={o.endSec}
                    onChange={(v) => patchOverlay(o.key, { endSec: v })}
                    testID={`input-directed-text-end-${i}`} />
                </View>
              </View>
            ))}
          </Section>

          {props.blockReason ? (
            <Text style={styles.error} accessibilityRole="alert" testID="text-directed-block-reason">
              {props.blockReason}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  toggleRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontFamily: fonts.semiBold, fontSize: 13, color: c.foreground },
  hint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: c.mutedForeground },
  error: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 17, color: c.destructive },
  section: { gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 10 },
  sectionTitle: {
    fontFamily: fonts.semiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: c.mutedForeground,
  },
  fieldLabel: { fontFamily: fonts.medium, fontSize: 12, color: c.foreground },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  option: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  optionSelected: { borderColor: c.primary, backgroundColor: c.accent },
  optionText: { fontFamily: fonts.medium, fontSize: 12, color: c.mutedForeground },
  optionTextSelected: { color: c.accentForeground },
  smallButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  iconButton: { width: 36, paddingHorizontal: 0, justifyContent: "center" },
  smallButtonText: { fontFamily: fonts.semiBold, fontSize: 12 },
  textArea: {
    minHeight: 56,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.card,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.foreground,
    textAlignVertical: "top",
  },
  row: {
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground },
  timeRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end" },
  timeInput: {
    width: 72,
    minHeight: 36,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.background,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.foreground,
  },
});
