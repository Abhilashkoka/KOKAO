/**
 * KOKAO now has two lip-sync passes, and they must never both run on one job.
 *
 *  - The CHARACTER pass (topic_to_video + visualsSource "character") syncs each
 *    shot to its own slice of the narration BEFORE the shots are composed. Its
 *    inputs are the raw generated clip and the original narration PCM.
 *  - The optional STUDIO pass is a finishing stage over the COMPOSED video. It
 *    cuts a segment out of the final file and re-extracts that segment's audio,
 *    which by then has been through the music mix, sidechain ducking, two
 *    loudnorm passes and an AAC round trip.
 *
 * On the character engine the first is strictly better: cleaner audio, one call
 * per shot instead of one call spanning every cut, and one less generation of
 * encode loss over the mouth. So where both would apply, the character pass
 * wins and the optional one is refused.
 *
 * Refused rather than silently dropped: the optional pass is a toggle the user
 * ticked, so they are told why it cannot apply instead of wondering where it
 * went. On every other engine the optional pass is the only pass, and this
 * predicate returns false.
 */
export function characterPassOwnsLipSync(args: {
  engine: string;
  visualsSource: string;
  /** Whether the character engine's own pass is active for this job. */
  characterLipSyncActive: boolean;
}): boolean {
  return (
    args.characterLipSyncActive === true &&
    args.engine === "topic_to_video" &&
    args.visualsSource === "character"
  );
}

/** Summarize how much of the optional per-scene pass actually landed. */
export function summariseStudioLipSyncScenes(
  scenes: ReadonlyArray<{ state: string; event?: unknown }> | undefined,
): { synced: number; skipped: number; billable: number } {
  const list = scenes ?? [];
  return {
    synced: list.filter((scene) => scene.state === "complete").length,
    skipped: list.filter((scene) => scene.state === "skipped").length,
    billable: list.filter((scene) => scene.event != null).length,
  };
}

/** User-facing refusal for the redundant second pass. */
export const STUDIO_PASS_REDUNDANT_MESSAGE =
  "This video already lip-syncs every character scene to its own line, shot by shot. " +
  "Turn the optional pass off — adding it would sync the finished video a second time.";
