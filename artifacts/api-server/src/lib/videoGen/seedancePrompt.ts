import type {
  GuidedStoryCastSnapshot,
  GuidedStoryLocale,
  GuidedStoryScript,
  GuidedStoryVisualChoices,
} from "@workspace/db";
import { GUIDED_STORY_LANGUAGES } from "./guidedStory";

type ScriptScene = GuidedStoryScript["scenes"][number];
type ScriptLine = ScriptScene["lines"][number];

export const SEEDANCE_MAX_SEGMENT_SEC = 30;

export const SEEDANCE_BRACKETS = {
  music: ["(", ")"],
  sfx: ["<", ">"],
  voice: ["{", "}"],
  caption: ["【", "】"],
} as const;

export const SEEDANCE_DEFAULT_LOOK_EXCLUSION =
  "No cartoon, illustration or 3D-render look.";

export function isSeedance25Model(
  options:
    | { modelId?: string | null; resolvedVideoModel?: { model?: string | null } | null }
    | null
    | undefined,
): boolean {
  const model = options?.resolvedVideoModel?.model ?? options?.modelId ?? "";
  return model.trim().toLowerCase().includes("seedance-2.5");
}

function languageName(locale: GuidedStoryLocale): string {
  return (
    GUIDED_STORY_LANGUAGES.find((language) => language.locale === locale)?.languageName ??
    "English"
  );
}

export function clipSeconds(ms: number, sceneStartMs: number): number {
  return Math.max(0, Math.round((ms - sceneStartMs) / 1000));
}

export function dialogueNumbering(script: GuidedStoryScript): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const scene of script.scenes) {
    for (const line of [...scene.lines].sort((a, b) => a.startMs - b.startMs)) {
      numbers.set(line.id, numbers.size + 1);
    }
  }
  return numbers;
}

export interface SeedanceReferenceSlot {
  slot: number;
  kind: "identity" | "wardrobe" | "backdrop";
  path: string | null;
  defines: string;
}

export function referenceSlots(
  sceneCast: GuidedStoryCastSnapshot[],
  backdrop: { imagePath: string; prompt: string } | null,
): SeedanceReferenceSlot[] {
  const slots: Omit<SeedanceReferenceSlot, "slot">[] = [];
  for (const member of sceneCast) {
    slots.push({
      kind: "identity",
      path: member.character.referenceImagePath,
      defines: `${member.character.name}'s face and hair`,
    });
    slots.push({
      kind: "wardrobe",
      path: member.outfit?.referenceImagePath ?? null,
      defines: `${member.character.name}'s clothing — ${
        member.outfit?.description ?? "the approved wardrobe"
      }`,
    });
  }
  if (backdrop) {
    slots.push({ kind: "backdrop", path: backdrop.imagePath, defines: backdrop.prompt });
  }
  return slots.map((slot, index) => ({ slot: index + 1, ...slot }));
}

export interface SeedanceSceneInput {
  scriptScene: ScriptScene;
  sceneCast: GuidedStoryCastSnapshot[];
  backdrop: { imagePath: string; prompt: string } | null;
  location: GuidedStoryVisualChoices["location"];
  platform: { aspectRatio: string; safeArea: string };
  locale: GuidedStoryLocale;
  dialogueNumbers: Map<string, number>;
  segmentIndex: number;
  segmentCount: number;
  carriedState?: string | null;
  caption?: string | null;
  music?: string | null;
  sfx?: string | null;
  lookExclusion?: string;
  /**
   * Reviewed storyboards send one approved opening frame to the video model.
   * The default keeps the standalone multi-reference contract available for
   * providers that can upload the character assets positionally.
   */
  referenceMode?: "character-assets" | "opening-frame";
  nativeAudio?: boolean;
}

function speaks(line: ScriptLine): boolean {
  return line.text.trim().length > 0;
}

function speakerName(line: ScriptLine, sceneCast: GuidedStoryCastSnapshot[]): string {
  if (!line.ownerRoleId) return "Narrator";
  return (
    sceneCast.find((member) => member.roleId === line.ownerRoleId)?.character.name ??
    line.ownerRoleId
  );
}

export function seedanceScenePrompt(input: SeedanceSceneInput): string {
  const scene = input.scriptScene;
  const durationSec = Math.round((scene.endMs - scene.startMs) / 1000);
  const language = languageName(input.locale);
  const slots =
    input.referenceMode === "opening-frame"
      ? []
      : referenceSlots(input.sceneCast, input.backdrop);
  const lines = [...scene.lines].sort((a, b) => a.startMs - b.startMs).filter(speaks);
  const blocks: string[] = [];
  blocks.push(
    [
      "[GOAL]",
      `One continuous ${durationSec}-second shot.`,
      `Segment ${input.segmentIndex + 1} of ${input.segmentCount}. All times below are local to this ${durationSec}-second clip.`,
    ].join("\n"),
  );
  if (input.carriedState) {
    blocks.push(
      [
        "[CONTINUITY]",
        `This clip opens on exactly the image the previous clip ended on: ${input.carriedState}`,
        "Same people, same wardrobe, same hair, same place, same time of day, same lighting direction, same spatial axis, same grade.",
      ].join("\n"),
    );
  }
  const references =
    input.referenceMode === "opening-frame"
      ? [
          "@Image 1 defines the approved opening frame, including every character, wardrobe, prop, and backdrop visible in this shot.",
        ]
      : slots.map((slot) => `@Image ${slot.slot} defines ${slot.defines}.`);
  for (const member of input.sceneCast) {
    references.push(
      `The references show one ${member.character.name}. The video contains exactly one ${member.character.name}.`,
    );
  }
  if (input.sceneCast.length) {
    const names = input.sceneCast.map((member) => member.character.name);
    references.push(
      `${names.length === 1 ? "One person is" : `${names.length} people are`} in this shot: ` +
        `${names.join(", ")}. The frame holds that cast from the first frame to the last.`,
    );
  }
  if (!input.backdrop && input.location.mode === "text") {
    references.push(`Location: ${input.location.description}.`);
  }
  blocks.push(["[REFERENCES]", ...references].join("\n"));
  blocks.push(["[ACTION]", `0-${durationSec}s: ${scene.visualDirection}`].join("\n"));
  if (input.nativeAudio !== false && lines.length) {
    const spoken = lines.map((line) => {
      const number = input.dialogueNumbers.get(line.id);
      const at = clipSeconds(line.startMs, scene.startMs);
      const who = speakerName(line, input.sceneCast);
      return `Dialogue ${number ?? "?"} — ${at}s — ${who} says in ${language}: {${line.text}}`;
    });
    blocks.push(
      [
        "[DIALOGUE]",
        `Spoken language: ${language}. Every line is spoken in ${language}, exactly as written, and nothing else is spoken.`,
        ...spoken,
      ].join("\n"),
    );
  }
  const sound: string[] = [];
  if (input.sfx) sound.push(`<${input.sfx}>`);
  if (input.music) sound.push(`(${input.music})`);
  if (input.caption) sound.push(`【${input.caption}】`);
  if (sound.length) blocks.push(["[AUDIO AND ON-SCREEN]", ...sound].join("\n"));
  const exclusions = ["No logos. No watermarks."];
  if (!input.caption) exclusions.unshift("No captions, subtitles or on-screen text.");
  if (!input.music) exclusions.push("No background music.");
  exclusions.push(input.lookExclusion ?? SEEDANCE_DEFAULT_LOOK_EXCLUSION);
  blocks.push(["[EXCLUSIONS]", ...exclusions].join("\n"));
  blocks.push(
    [
      "[HOLD]",
      "One continuous take. No cut, no scene change, no new location inside this clip.",
      "Identity, wardrobe, location, props, lighting direction and grade stay as described above for the whole clip.",
      `Compose for ${input.platform.aspectRatio}. ${input.platform.safeArea}`,
    ].join("\n"),
  );
  return blocks.join("\n\n");
}