import type { VideoJobOptions } from "@workspace/db";

type Story = NonNullable<VideoJobOptions["guidedStory"]>;

/** Native speech is the default. An explicitly mapped cloned voice must never
 * be silently replaced by whatever voice a video provider invents. */
export function guidedUsesSavedVoice(story: Story): boolean {
  const speakers = new Set(story.script.scenes.flatMap(scene =>
    scene.lines.map(line => line.ownerRoleId).filter(Boolean),
  ));
  return story.cast.some(member =>
    speakers.has(member.roleId) && member.brandKitId != null &&
    member.voice.providerVoiceId != null,
  );
}

/** Fund scene-sized calls, rather than forcing every performance into 10s.
 * The resolver still checks the selected model's real supported durations. */
export function guidedSceneDurations(story: Story): number[] {
  return [...new Set(story.script.scenes.map(scene => {
    const seconds = (scene.endMs - scene.startMs) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
      throw new Error(`Scene ${scene.id} must be longer than zero and no longer than 30 seconds. Edit the script before generating.`);
    }
    return Math.ceil(seconds);
  }))];
}

export function guidedSavedVoiceSceneError(story: Story): string | null {
  const clonedRoles = new Set(story.cast.filter(member =>
    member.brandKitId != null && member.voice.providerVoiceId != null,
  ).map(member => member.roleId));
  const unsupported = story.script.scenes.find(scene =>
    scene.lines.some(line => line.ownerRoleId && clonedRoles.has(line.ownerRoleId)) &&
    (scene.roleIds.length !== 1 || scene.lines.some(line =>
      line.kind !== "dialogue" || line.ownerRoleId !== scene.roleIds[0],
    )),
  );
  return unsupported
    ? `Scene ${unsupported.id} uses a saved Brand Kit voice in a shared or mixed-narration shot. Exact-voice lip-sync currently requires a solo dialogue scene. Split this scene into solo speaking shots, or choose model-generated voices before generating.`
    : null;
}
