import type {
  GuidedStoryCastSnapshot,
  GuidedStoryScript,
  GuidedStoryVisualChoices,
} from "@workspace/db";

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
}

function roleClause(member: GuidedStoryCastSnapshot): string {
  return (
    `${member.character.name} (${member.roleId}) wears ` +
    `${member.outfit?.description ?? "the approved wardrobe"}; ` +
    `identity reference ${member.character.referenceImagePath ?? "MISSING"}; ` +
    `outfit reference ${member.outfit?.referenceImagePath ?? "MISSING"}.`
  );
}

function locationClause(input: GuidedSceneVisualInput): string {
  if (input.backdrop) {
    return (
      `Use the frozen approved ${input.backdropLabel} backdrop ${input.backdrop.imagePath}. ` +
      `Backdrop direction: ${input.backdrop.prompt}. ` +
      "Preserve this location unless an explicitly scene-only background correction is requested."
    );
  }
  if (input.location.mode === "image") {
    return `Use the shared location image ${input.location.imagePath} as environmental guidance.`;
  }
  if (input.location.mode === "text") {
    return `Shared location direction: ${input.location.description}.`;
  }
  return "";
}

export function guidedSceneVisualPrompt(input: GuidedSceneVisualInput): string {
  const roleDirection = input.sceneCast.map(roleClause).join(" ");
  const locationDirection = locationClause(input);
  const logoDirection = input.logoPath
    ? `Place the approved logo ${input.logoPath} subtly in this scene.`
    : "";
  return (
    `${input.scriptScene.visualDirection}\n` +
    `${roleDirection}\n` +
    `${locationDirection}\n` +
    `${logoDirection}\n` +
    `Compose for ${input.platform.aspectRatio}. ${input.platform.safeArea}`
  );
}