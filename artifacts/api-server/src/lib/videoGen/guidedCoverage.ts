import type { GuidedStoryScript } from "@workspace/db";

/** Which way a character looks, so cut shots read as a conversation. */
export type Eyeline = "left" | "right" | "center";

export interface CoverageShot {
  roleIds: string[];
  speakerRoleId: string | null;
  kind: "single" | "group" | "reaction";
  eyeline: Eyeline;
  startMs: number;
  endMs: number;
  lineIds: string[];
}

export const MIN_SHOT_MS = 1200;
export const MAX_SCRIPT_SCENES = 40;

export function eyelineForRole(roleId: string, sceneRoleIds: readonly string[]): Eyeline {
  const index = sceneRoleIds.indexOf(roleId);
  if (index === 0) return "right";
  if (index === 1) return "left";
  return "center";
}

type ScriptScene = GuidedStoryScript["scenes"][number];
type ScriptLine = ScriptScene["lines"][number];

function turnsOf(lines: readonly ScriptLine[]): Array<{
  ownerRoleId: string | null;
  lines: ScriptLine[];
  startMs: number;
  endMs: number;
}> {
  const turns: Array<{
    ownerRoleId: string | null;
    lines: ScriptLine[];
    startMs: number;
    endMs: number;
  }> = [];
  for (const line of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    const owner = line.kind === "dialogue" ? line.ownerRoleId : null;
    const last = turns[turns.length - 1];
    if (last && last.ownerRoleId === owner) {
      last.lines.push(line);
      last.endMs = Math.max(last.endMs, line.endMs);
    } else {
      turns.push({
        ownerRoleId: owner,
        lines: [line],
        startMs: line.startMs,
        endMs: line.endMs,
      });
    }
  }
  return turns;
}

export function planSceneCoverage(scene: ScriptScene): CoverageShot[] {
  const whole = (
    kind: CoverageShot["kind"],
    speakerRoleId: string | null,
  ): CoverageShot => ({
    roleIds: [...scene.roleIds],
    speakerRoleId,
    kind,
    eyeline:
      speakerRoleId && scene.roleIds.length > 1
        ? eyelineForRole(speakerRoleId, scene.roleIds)
        : "center",
    startMs: scene.startMs,
    endMs: scene.endMs,
    lineIds: scene.lines.map((line) => line.id),
  });

  const turns = turnsOf(scene.lines);
  const speaking = turns.filter((turn) => turn.ownerRoleId !== null);
  const speakers = new Set(speaking.map((turn) => turn.ownerRoleId!));

  if (scene.roleIds.length <= 1 || speaking.length === 0) {
    return [
      whole(
        speaking.length === 1 ? "single" : "group",
        speaking.length === 1 ? speaking[0]!.ownerRoleId : null,
      ),
    ];
  }
  if (speakers.size === 1 && speaking.length === turns.length) {
    const speakerRoleId = [...speakers][0]!;
    return [{
      ...whole("single", speakerRoleId),
      roleIds: [speakerRoleId],
    }];
  }

  const shots: CoverageShot[] = [];
  for (const turn of turns) {
    const previous = shots[shots.length - 1];
    const tooShort = turn.endMs - turn.startMs < MIN_SHOT_MS;
    if (previous && (tooShort || turn.ownerRoleId === null)) {
      previous.endMs = turn.endMs;
      previous.lineIds.push(...turn.lines.map((line) => line.id));
      continue;
    }
    if (turn.ownerRoleId === null) {
      shots.push({
        roleIds: [...scene.roleIds],
        speakerRoleId: null,
        kind: "group",
        eyeline: "center",
        startMs: turn.startMs,
        endMs: turn.endMs,
        lineIds: turn.lines.map((line) => line.id),
      });
      continue;
    }
    shots.push({
      roleIds: [turn.ownerRoleId],
      speakerRoleId: turn.ownerRoleId,
      kind: "single",
      eyeline: eyelineForRole(turn.ownerRoleId, scene.roleIds),
      startMs: turn.startMs,
      endMs: turn.endMs,
      lineIds: turn.lines.map((line) => line.id),
    });
  }

  if (shots.length <= 1) {
    return [whole(speakers.size === 1 ? "single" : "group", null)];
  }

  shots[0]!.startMs = scene.startMs;
  shots[shots.length - 1]!.endMs = scene.endMs;
  for (let index = 1; index < shots.length; index += 1) {
    shots[index]!.startMs = shots[index - 1]!.endMs;
  }
  return shots;
}

export function expandScriptCoverage(
  script: GuidedStoryScript,
  maxScenes = MAX_SCRIPT_SCENES,
): GuidedStoryScript {
  const scenes: GuidedStoryScript["scenes"] = [];
  const nameOf = new Map(script.roles.map((role) => [role.id, role.name]));
  let total = script.scenes.length;
  for (const scene of script.scenes) {
    const shots = planSceneCoverage(scene);
    if (total + shots.length - 1 > maxScenes) {
      scenes.push(scene);
      continue;
    }
    total += shots.length - 1;
    if (
      shots.length === 1 &&
      shots[0]!.roleIds.length === scene.roleIds.length
    ) {
      scenes.push(scene);
      continue;
    }
    const linesById = new Map(scene.lines.map((line) => [line.id, line]));
    shots.forEach((shot, index) => {
      scenes.push({
        ...scene,
        id: shots.length === 1 ? scene.id : `${scene.id}-s${index + 1}`,
        startMs: shot.startMs,
        endMs: shot.endMs,
        roleIds: shot.roleIds,
        visualDirection: shotVisualDirection(scene.visualDirection, shot, {
          speaker: shot.speakerRoleId ? nameOf.get(shot.speakerRoleId) : null,
          others: scene.roleIds
            .filter((id) => id !== shot.speakerRoleId)
            .map((id) => nameOf.get(id) ?? "")
            .filter(Boolean),
        }),
        lines: shot.lineIds
          .map((lineId) => linesById.get(lineId)!)
          .filter(Boolean),
      });
    });
  }
  return { ...script, scenes };
}

const MULTI_SUBJECT_CUES = [
  "both",
  "they",
  "them",
  "their",
  "together",
  "each other",
  "couple",
  "beside",
  "next to",
  "two of",
  "pair of",
  "one another",
  "mirror",
  "reflect",
  "selfie",
];

export function settingOnly(
  sceneDirection: string,
  otherNames: readonly string[],
): string {
  const names = otherNames.map((name) => name.toLowerCase()).filter(Boolean);
  return sceneDirection
    .split(/(?<=[.;])\s+/)
    .filter((clause) => {
      const lower = clause.toLowerCase();
      if (
        names.some((name) => new RegExp(`\\b${name}\\b`).test(lower))
      ) {
        return false;
      }
      return !MULTI_SUBJECT_CUES.some((cue) =>
        new RegExp(`\\b${cue}`).test(lower),
      );
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[;,]$/, ".");
}

export function shotVisualDirection(
  sceneDirection: string,
  shot: CoverageShot,
  names: { speaker?: string | null; others?: readonly string[] } = {},
): string {
  if (shot.kind === "group") {
    return (
      `${sceneDirection.trim()} This shot shows the characters together in the location. ` +
      "Same location, same lighting and same time of day as the rest of the scene."
    );
  }
  const who = names.speaker
    ? `only ${names.speaker}`
    : "only the speaking character";
  const facing =
    shot.eyeline === "center"
      ? "facing the camera"
      : `mostly front-facing, turned just slightly toward screen-${shot.eyeline}, ` +
        "eyes toward the person they are speaking with just off-frame";
  const setting = settingOnly(sceneDirection, names.others ?? []);
  return (
    `Single-subject shot. Frame ${who}: one person, one face, from the chest up, ` +
    `${facing}. The face and mouth are fully visible and unobstructed. ` +
    "Do not include any other person, any second face, any mirror or any reflection. " +
    (shot.kind === "reaction" ? "They are listening, not speaking. " : "") +
    (setting ? `Setting: ${setting} ` : "") +
    "Same location, lighting, wardrobe and time of day as the rest of the scene."
  );
}