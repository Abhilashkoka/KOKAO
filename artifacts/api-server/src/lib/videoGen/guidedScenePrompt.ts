import type {
  GuidedStoryCastSnapshot,
  GuidedStoryScript,
  GuidedStoryVisualChoices,
} from "@workspace/db";
import { VideoGenProviderError } from "./types";

type PlatformFraming = { aspectRatio: string; safeArea: string };
type ScriptScene = GuidedStoryScript["scenes"][number];

export type GuidedBackdropLabel = "scene override" | "default" | "shared";

export interface GuidedSceneVisualInput {
  scriptScene: Pick<ScriptScene, "visualDirection">;
  sceneCast: GuidedStoryCastSnapshot[];
  backdrop: { imagePath: string; prompt: string } | null;
  backdropLabel: GuidedBackdropLabel;
  location: GuidedStoryVisualChoices["location"];
  logoPath: string | null;
  platform: PlatformFraming;
  /**
   * Positional labels for the references actually attached to this request,
   * as character-sheet/outfit pairs in cast order — "@Image1", "@Image2",
   * then "@Image3", "@Image4". Supply these only once the caller really is
   * sending reference assets: naming a reference that was not sent is worse
   * than naming none.
   */
  referenceLabels?: readonly string[];
}

/**
 * Guided Story scene prompts.
 *
 * Rewritten after job #69001, where a three-scene story rendered the mother as
 * two visibly different women and lost two of three characters from the
 * closing shot. Three faults lived in this file:
 *
 *  1. `identity reference /objects/4/uploads/<uuid>` went into the prompt as
 *     text. That is tenant storage — no video model resolves it, so the
 *     identity direction did nothing while reading as though it worked.
 *     Identity travels as an attached reference (assetIds → Atlas
 *     `reference_images`), never as a path inside a sentence.
 *  2. The backdrop direction carried the whole storyboard — "Scene 1: …
 *     Scene 2: … Scene 3: …", the last truncated mid-sentence — into every
 *     scene. The model was handed three shots and asked for one.
 *  3. The cast was described but never closed, so a scene asking to "end on
 *     all three smiling together" could return one person and be, on its own
 *     terms, correct.
 *
 * The rule the whole file now follows: everything in this string must be
 * something a model can act on. Anything addressed to our own systems belongs
 * in the request, not in the prose.
 */

/** Anything that means something to us and nothing to a video model. */
const STORAGE_PATH = /(\/objects\/\d+\/[\w/-]+|\bfile:\/\/\S+)/;

/**
 * A last line of defence rather than the mechanism: the builders below simply
 * never interpolate a path. If one ever starts again, this turns a silently
 * wrong render into a failure that names the offending text.
 */
function assertNoStoragePaths(prompt: string): string {
  const match = prompt.match(STORAGE_PATH);
  if (match) {
    throw new VideoGenProviderError(
      `A Guided Story prompt named an app storage path (${match[0]}). ` +
        "References must be attached to the request, not written into the prompt text.",
      400,
    );
  }
  return prompt;
}

/**
 * Cut a whole-storyboard dump down to the shot being rendered.
 *
 * The backdrop direction in #69001 opened with a one-line brief and then
 * pasted every scene of the story after it. Everything from the first
 * "Scene N:" onwards is other shots, and a trailing "She...." is an
 * unfinished sentence a model will happily finish.
 */
export function stripStoryboardDump(text: string): string {
  const upToFirstScene = text.split(/(?:^|\s)Scene\s+\d+\s*:/)[0] ?? text;
  return upToFirstScene
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/\.{3,}$/.test(line))
    .join(" ")
    .trim();
}

/**
 * What the model needs about one character: who they are in this shot, and
 * what they wear. Appearance itself comes from the attached reference — long
 * appearance text competes with the image and degrades it, and the role
 * descriptions here ("anxious but witty") are personality, which is not
 * visible at all.
 */
function roleClause(
  member: GuidedStoryCastSnapshot,
  labels: readonly string[],
): string {
  const wardrobe = member.outfit?.description?.trim();
  if (!wardrobe) {
    throw new VideoGenProviderError(
      `${member.character.name} has no approved outfit for this scene. ` +
        "Approve a wardrobe before generating — an unspecified costume changes between shots.",
      400,
    );
  }
  const named = labels.length === 2
    ? `${member.character.name}'s approved character sheet is ${labels[0]} and approved outfit reference is ${labels[1]}`
    : member.character.name;
  return `${named}, wearing ${wardrobe}, matching their approved reference exactly.`;
}

/** The cast as a closed set, which is what stops characters quietly leaving. */
function castClause(sceneCast: GuidedStoryCastSnapshot[]): string {
  const names = sceneCast.map((m) => m.character.name);
  if (names.length === 0) return "";
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    `Exactly ${names.length} ${names.length === 1 ? "person is" : "people are"} in frame: ${list}. ` +
    "All of them stay visible for the whole shot; no one enters and no one leaves."
  );
}

function locationClause(input: GuidedSceneVisualInput): string {
  if (input.backdrop) {
    const direction = stripStoryboardDump(input.backdrop.prompt);
    return (
      `The location is the approved ${input.backdropLabel} backdrop` +
      (direction ? `: ${direction}` : ".") +
      " Keep this location unchanged for the whole shot."
    );
  }
  if (input.location.mode === "image") {
    return "The location is the approved shared location image.";
  }
  if (input.location.mode === "text" && input.location.description?.trim()) {
    return `Shared location direction: ${stripStoryboardDump(input.location.description)}`;
  }
  return "";
}

export function guidedSceneVisualPrompt(input: GuidedSceneVisualInput): string {
  const labels = input.referenceLabels ?? [];
  const blocks = [
    stripStoryboardDump(input.scriptScene.visualDirection),
    input.sceneCast.map((member, i) => roleClause(member, labels.slice(i * 2, i * 2 + 2))).join(" "),
    castClause(input.sceneCast),
    locationClause(input),
    // The logo is composited, not described. A path here was never actionable,
    // and the bare word "logo" invites the model to invent one.
    input.logoPath ? "Leave clear space in the lower third for a logo overlay." : "",
    // Last, so the final thing read is what must not change.
    "Every face, hairstyle, build and garment stays identical to the references for the entire shot.",
    `Compose for ${input.platform.aspectRatio}. ${input.platform.safeArea}`,
  ];
  return assertNoStoragePaths(blocks.filter((b) => b.trim().length > 0).join("\n"));
}