import type { VideoGeneration } from "@workspace/db";

export type VideoCopySourceType = "guided_script" | "walkthrough_script" | "character_script" | "narration" | "brief";

/** Only approved/persisted words are treated as spoken video copy. A prompt is a brief, not a transcript. */
export function videoLibraryCopySource(job: Pick<VideoGeneration, "options" | "storyboard" | "prompt">):
  { text: string; sourceType: VideoCopySourceType } | null {
  const options = job.options;
  const guided = options?.guidedStory?.script;
  const guidedText = guided
    ? [guided.title, guided.logline, ...guided.scenes.flatMap((scene) =>
        scene.lines.map((line) => line.text))].filter(Boolean).join("\n")
    : "";
  const screen = options?.hybridStory?.screenDemo;
  const screenText = screen?.generatedScript?.trim() || screen?.script?.trim() || "";
  const characterText = options?.characterDialogue?.script?.trim() || options?.dialogue?.trim() || "";
  const narrationText = job.storyboard?.scenes?.map((scene) => scene.text?.trim())
    .filter(Boolean).join("\n") || job.storyboard?.narration?.cues?.map((cue) => cue.text?.trim())
    .filter(Boolean).join("\n") || "";
  const walkthroughText = screenText
    ? narrationText && !narrationText.includes(screenText)
      ? `${screenText}\n${narrationText}`
      : narrationText || screenText
    : "";
  const candidates: Array<[VideoCopySourceType, string]> = [
    ["guided_script", guidedText],
    ["walkthrough_script", walkthroughText],
    ["character_script", characterText],
    ["narration", narrationText],
    ["brief", job.prompt?.trim() || ""],
  ];
  const found = candidates.find(([, text]) => text.trim());
  return found ? { sourceType: found[0], text: found[1].slice(0, 9000) } : null;
}