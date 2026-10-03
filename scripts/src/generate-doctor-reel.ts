import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateWithAtlasCloud } from "../../artifacts/api-server/src/lib/videoGen/providers/atlascloud";

// One explicitly requested creator test; no tenant wallet or existing job is changed.
// Persist submission before the paid call and resume accepted tasks on reruns.
const dir = resolve("attached_assets/generated_videos/doctor-brand-reel");
const checkpointPath = resolve(dir, "checkpoint.json");
type Checkpoint = {
  state: "submitting" | "accepted" | "rejected" | "completed";
  taskId?: string;
  requestId?: string | null;
};
let checkpoint: Checkpoint | null = null;
const persist = async (value: Checkpoint) => {
  await writeFile(checkpointPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  checkpoint = value;
};

const prompt = `Create one complete 30-second vertical 9:16 cinematic promotional reel for KOKAO, an AI social-content creation app. Deliver all shots in ONE video, including native English narration, subtle uplifting instrumental music and natural room sounds. Premium realistic advertising cinematography, warm daylight, understated teal clinic decor, charcoal and lime-green app branding.

TITLE / CREATIVE IDEA: "A doctor's brand video in a few minutes."
Use one fictional adult Indian female doctor, approximately 35, shoulder-length dark hair tied back, teal blouse and white coat. Preserve her exact face, clothes, desk, laptop and room across every camera change. No patients, no medical procedures, no real person impersonation. This is an illustrative concept ad, not evidence of actual app processing speed.

0-3 seconds: Medium close-up of the doctor at her desk staring at a blank social-media draft on her phone, thoughtful and short of time, not distressed. Native narrator: "Your expertise deserves an audience. But when?" Large clean white overlay: "No time to create?"

3-8 seconds: Motivated camera move over her shoulder to the laptop. She types a topic into a clean charcoal-and-lime app labelled "KOKAO": "5 myths about IVF". One clear input field, no invented charts or medical claims. Narrator: "Start with one topic in KOKAO." Overlay: "Start with one topic."

8-14 seconds: A fluid progression of illustrative script lines, preview cards and caption cards appearing in the same laptop interface. The doctor watches. Treat the screen as a stylized product visualization, not a documentary recording. Do not put tiny unreadable text across the entire frame. Narrator: "Turn your ideas into a script, video and captions." Overlay: "Script. Video. Captions."

14-24 seconds: Camera pushes into a vertical preview on the laptop, revealing the finished doctor reel, now filling the frame. The SAME doctor in the SAME wardrobe addresses the camera in a bright clinic, with small natural gestures and professionally composed close and medium angles. Keep her silent beneath the narrator; no lip-flapping or competing speech. Show a tasteful title "IVF: 5 common myths" without enumerating medical claims. Narrator: "From your knowledge to your next reel, in a few minutes. Review it, then share." Overlay: "A doctor's brand video in a few minutes."

24-30 seconds: Pull back to the satisfied doctor, then a clean graceful transition into a charcoal end frame with a lime-green circular motif and bold white typeset wordmark "KOKAO", followed by exact lowercase "kokao.in". Hold the readable end frame for at least three seconds. Narrator: "Create with KOKAO. Review. Publish." Final overlay: "Create. Review. Publish."

Read all narration naturally, with pauses; no rushed speech. Maintain continuous musical ambience across shots. All text inside safe margins away from the bottom 20 percent and rightmost 12 percent. Short crisp readable typography. Do not show "3 minutes", "NMC-safe", medical compliance certification, guaranteed patient outcomes, "No editing", or "No agency". No duplicate doctor, changing face, extra fingers, watermarks from other brands, fake endorsements, subtitles repeating every spoken word, or unsupported medical advice. Camera cuts are generated within this one output; do not split this request into separate clips.`;

async function main() {
  await mkdir(dir, { recursive: true });
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (checkpoint?.state === "completed") {
    console.log("Already completed; no additional paid request made.");
    return;
  }
  if (checkpoint?.state === "submitting" || checkpoint?.state === "rejected") {
    throw new Error("Submission requires manual review; refusing another paid create.");
  }
  if (!process.env.ATLASCLOUD_API_KEY) throw new Error("Atlas Cloud key unavailable.");
  await writeFile(resolve(dir, "creative-brief.txt"), prompt);
  console.log("Generating one 30-second 9:16 1080p Wan 3.0 reel.");
  const result = await generateWithAtlasCloud({
    model: "alibaba/wan-3.0/text-to-video",
    prompt, durationSec: 30, aspectRatio: "9:16", resolution: "1080p",
    generateAudio: true, meterContext: null,
    providerTaskId: checkpoint?.taskId,
    providerRequestId: checkpoint?.requestId,
    onProviderSubmitStarted: () => persist({ state: "submitting" }),
    onProviderSubmitRejected: () => persist({ state: "rejected" }),
    onProviderTaskAccepted: async (receipt) => {
      await persist({ state: "accepted", ...receipt });
      console.log("Provider accepted the single generation; waiting for output.");
    },
  }, process.env.ATLASCLOUD_API_KEY);
  await writeFile(resolve(dir, "kokao-doctor-brand-reel.mp4"), result.buffer);
  await persist({
    state: "completed", taskId: result.providerTaskId,
    requestId: result.providerRequestId,
  });
  console.log("Saved attached_assets/generated_videos/doctor-brand-reel/kokao-doctor-brand-reel.mp4");
}

main().then(() => process.exit(0)).catch((error) => {
  // Never dump request headers, credentials, or signed output URLs.
  console.error("Generation stopped:", error?.name ?? "Error",
    "status:", error?.status ?? "unknown",
    "category:", error?.failureCategory ?? "unknown");
  process.exit(1);
});