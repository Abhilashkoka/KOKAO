import { db, videoStyleProfilesTable } from "@workspace/db";
import type { TemplateSlot, VideoStyleProfilePayload } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

/**
 * The initial formats intentionally contain only format guidance. They never
 * carry an account, upload path, transcript, or other workspace-owned data.
 * They are inserted at boot so a newly provisioned database is immediately
 * useful, while an admin's unpublish decision remains authoritative afterward.
 */
const SCRIPT_SLOT: TemplateSlot = {
  kind: "script",
  required: true,
  label: "Your topic or script",
  hint: "Add a clear topic or paste the words you want the video to cover.",
};

const DEFAULT_PAYLOAD = (overrides: Partial<VideoStyleProfilePayload> = {}): VideoStyleProfilePayload => ({
  version: 1,
  hookShape: "A concise, benefit-led opening in the first three seconds.",
  pacing: { sceneCount: 3, avgSceneSec: 10, wordsPerMinute: 145 },
  captionStyle: "dynamic",
  energy: "clear and confident",
  visualNotes: ["Keep key text inside the vertical safe area.", "Use one visual idea per beat."],
  scriptGuidance: "Open with the audience benefit, explain one useful idea, and end with a direct next step.",
  sourceDurationSec: 30,
  transcriptExcerpt: "",
  ...overrides,
});

export const DEFAULT_KOKAO_VIDEO_TEMPLATES: {
  name: string;
  summary: string;
  slots: TemplateSlot[];
  jobDefaults: Record<string, unknown>;
  payload: VideoStyleProfilePayload;
}[] = [
  {
    name: "Quick Explainer",
    summary: "A punchy vertical explanation with bold captions and supporting stock visuals.",
    slots: [SCRIPT_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      durationSec: 30,
      subtitles: true,
      captionStyle: "dynamic",
      paragraphCount: 1,
      visualsSource: "stock",
      stockSource: "auto",
    },
    payload: DEFAULT_PAYLOAD(),
  },
  {
    name: "Problem → Proof → Next Step",
    summary: "A simple three-beat format for product, service, and educational stories.",
    slots: [SCRIPT_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      durationSec: 30,
      subtitles: true,
      captionStyle: "classic",
      paragraphCount: 2,
      visualsSource: "stock",
      stockSource: "auto",
    },
    payload: DEFAULT_PAYLOAD({
      hookShape: "Name a familiar problem immediately, then show the proof and a practical next step.",
      pacing: { sceneCount: 4, avgSceneSec: 11.25, wordsPerMinute: 135 },
      captionStyle: "classic",
      energy: "helpful and grounded",
      scriptGuidance: "State the problem, give one credible proof point, and close with the next action.",
    }),
  },
];

/**
 * Provision the first KOKAO formats exactly once per database. An advisory
 * transaction lock prevents duplicate inserts if multiple API processes boot
 * concurrently. Existing rows are left untouched so publishing decisions stay
 * under superadmin control.
 */
export async function seedDefaultVideoTemplates(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1026001)`);
    const existing = await tx
      .select({ id: videoStyleProfilesTable.id })
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.scope, "platform"))
      .limit(1);
    if (existing.length > 0) return;
    await tx.insert(videoStyleProfilesTable).values(
      DEFAULT_KOKAO_VIDEO_TEMPLATES.map((template) => ({
        tenantId: null,
        scope: "platform" as const,
        sourceKind: "curated" as const,
        published: true,
        ...template,
      })),
    );
  });
}