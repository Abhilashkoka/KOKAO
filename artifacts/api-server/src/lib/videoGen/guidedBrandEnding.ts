import { createHash } from "node:crypto";
import type { GuidedStoryDraft, GuidedStoryScript, VideoJobOptions } from "@workspace/db";
import { loadActivePayload } from "../brandKit/service";
import {
  DISABLED_BRAND_OUTRO,
  inspectBrandOutroClip,
  validateBrandOutroSettings,
  type BrandOutroSnapshot,
} from "./brandOutro";

export type BrandEndingChoice = { choice: "replace" | "keep" | "append"; token: string };

/** Conservative suggestion only. A person-free scene alone is not an end card. */
export function replaceableBrandEnding(script: GuidedStoryScript | null | undefined) {
  if (!script || script.scenes.length < 2) return null;
  const scene = script.scenes.at(-1)!;
  if (scene.roleIds.length || scene.lines.some(line => line.ownerRoleId != null || line.kind === "dialogue")) return null;
  const direction = scene.visualDirection;
  const ending = /\b(?:end[\s-]?card|outro|closing\s+(?:card|logo|brand)|final\s+(?:card|logo|brand))\b/i;
  const branded = /\b(?:brand(?:ed|ing)?|logo)\b/i;
  return ending.test(direction) && branded.test(direction) ? scene : null;
}

export async function loadGuidedBrandEnding(draft: GuidedStoryDraft) {
  const unavailable = { offer: { available: false as const, revision: draft.revision }, snapshot: null };
  const kitId = draft.state.setup?.brandKitId;
  if (!kitId || !draft.state.script) return unavailable;
  const active = await loadActivePayload(draft.tenantId, kitId);
  const settings = active?.payload.video_outro;
  // An uploaded clip can be chosen for this video even if the kit-wide default
  // is off. Preset-only kits retain their existing behavior.
  if (!settings || settings.mode !== "upload" || !settings.clip_path) return unavailable;
  const snapshot = validateBrandOutroSettings({ ...settings, enabled: true }, draft.tenantId, null);
  const clip = await inspectBrandOutroClip(snapshot, draft.tenantId);
  const frozen = { ...snapshot, clipSha256: clip.sha256 };
  const scene = replaceableBrandEnding(draft.state.script);
  const storyDurationSeconds = draft.state.script.scenes.reduce((sum, item) => sum + (item.endMs - item.startMs) / 1000, 0);
  const sceneDurationSeconds = scene ? (scene.endMs - scene.startMs) / 1000 : null;
  const token = createHash("sha256").update(JSON.stringify({
    tenantId: draft.tenantId,
    draftId: draft.id,
    revision: draft.revision,
    script: draft.state.script,
    snapshot: frozen,
  })).digest("hex");
  return {
    snapshot: frozen,
    offer: {
      available: true as const,
      revision: draft.revision,
      token,
      clipPath: frozen.clipPath!,
      clipDurationSeconds: clip.duration,
      hasAudio: clip.hasAudio,
      replaceSceneId: scene?.id ?? null,
      replaceSceneDescription: scene?.visualDirection ?? null,
      sceneDurationSeconds,
      storyDurationSeconds,
      replacementDurationSeconds: sceneDurationSeconds == null ? null : storyDurationSeconds - sceneDurationSeconds + clip.duration,
      appendedDurationSeconds: storyDurationSeconds + clip.duration,
    },
  };
}

export type GuidedBrandEndingApproval = {
  snapshot: BrandOutroSnapshot;
  decision: NonNullable<VideoJobOptions["guidedBrandEnding"]>;
};

/** Called before the enqueue claim or any funding. All media comes from the kit, never the request. */
export async function confirmGuidedBrandEnding(
  draft: GuidedStoryDraft,
  choice: BrandEndingChoice | undefined,
): Promise<GuidedBrandEndingApproval | null> {
  const current = await loadGuidedBrandEnding(draft);
  if (!current.offer.available) {
    if (choice) throw new Error("The saved brand animation is no longer available. Review the ending again.");
    return null;
  }
  if (!choice || current.offer.token !== choice.token) {
    throw new Error("Review the current brand animation and confirm how to use it before generating. The story or animation may have changed.");
  }
  if (choice.choice === "replace" && !current.offer.replaceSceneId) {
    throw new Error("Only a final, character-free branded end card can be replaced. Keep the story or append the animation.");
  }
  return {
    snapshot: choice.choice === "keep" ? { ...DISABLED_BRAND_OUTRO } : current.snapshot!,
    decision: {
      version: 1,
      choice: choice.choice,
      token: choice.token,
      sceneId: choice.choice === "replace" ? current.offer.replaceSceneId : null,
      clipDurationSeconds: current.offer.clipDurationSeconds,
      ...(choice.choice === "replace" ? { originalScript: structuredClone(draft.state.script!) } : {}),
    },
  };
}

/** Derive the execution script from an explicit confirmation, preserving the source for audit/recovery. */
export function applyGuidedBrandEnding(
  options: VideoJobOptions & { brandOutro?: BrandOutroSnapshot },
  approval: GuidedBrandEndingApproval,
) {
  options.guidedBrandEnding = structuredClone(approval.decision);
  options.brandOutro = structuredClone(approval.snapshot);
  if (approval.decision.choice !== "replace") return;
  const script = options.guidedStory?.script;
  if (!script || replaceableBrandEnding(script)?.id !== approval.decision.sceneId) {
    throw new Error("The approved branded ending no longer matches the execution script.");
  }
  const scenes = structuredClone(script.scenes.slice(0, -1));
  const runtimeSeconds = scenes.reduce((sum, scene) => sum + (scene.endMs - scene.startMs) / 1000, 0);
  options.guidedStory = {
    ...options.guidedStory!,
    script: { ...script, scenes, runtimeSeconds },
    platform: { ...options.guidedStory!.platform, durationSeconds: runtimeSeconds },
  };
  options.durationSec = runtimeSeconds;
}