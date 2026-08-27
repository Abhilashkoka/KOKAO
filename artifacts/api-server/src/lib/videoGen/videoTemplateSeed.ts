import { db, videoStyleProfilesTable } from "@workspace/db";
import type { TemplateSlot, VideoStyleProfilePayload } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { assertTemplateSafe } from "./videoTemplates";

/**
 * The initial formats intentionally contain only format guidance. They never
 * carry an account, upload path, transcript, or other workspace-owned data.
 * They are inserted at boot so a newly provisioned database is immediately
 * useful, while an admin's unpublish decision remains authoritative afterward.
 */
const PRESENTER_SLOT: TemplateSlot = {
  kind: "presenter_video",
  required: true,
  label: "A take of you talking to camera",
  hint:
    "One continuous take, head and shoulders in the lower two-thirds of frame so the overlay has room above you. Shoot vertical.",
};

const SCRIPT_SLOT: TemplateSlot = {
  kind: "script",
  required: true,
  label: "What you want to say",
  hint: "Your own words. The template decides how it is illustrated, never what it says.",
};

const SAVED_CHARACTER_SLOT: TemplateSlot = {
  kind: "saved_character",
  required: true,
  label: "Your saved character",
  hint: "Choose a character and outfit from this workspace for every speaking beat.",
};

const BRAND_KIT_SLOT: TemplateSlot = {
  kind: "brand_kit",
  required: false,
  label: "A brand kit",
  hint: "Sets caption colour and the watermark. Optional.",
};

const MUSIC_SLOT: TemplateSlot = {
  kind: "music",
  required: false,
  label: "A music bed",
  hint: "Optional. Leave empty to keep only your voice.",
};

export const DEFAULT_KOKAO_VIDEO_TEMPLATES: {
  name: string;
  summary: string;
  slots: TemplateSlot[];
  jobDefaults: Record<string, unknown>;
  payload: VideoStyleProfilePayload;
}[] = [
  {
    name: "Hybrid Character Story",
    summary: "Your character opens and closes a narrated story, alternating with cinematic animation.",
    slots: [SAVED_CHARACTER_SLOT, SCRIPT_SLOT, BRAND_KIT_SLOT, MUSIC_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      format: "hybrid_character_story",
      visualStrategy: "ai_video",
      visualsSource: "ai_video",
      reviewStoryboard: true,
      subtitles: true,
      captionStyle: "dynamic",
      hybridBeatPattern: [
        { kind: "character_opening", maxDurationSeconds: 12 },
        { kind: "story_animation", maxDurationSeconds: 20 },
        { kind: "character_interlude", maxDurationSeconds: 10 },
        { kind: "story_animation", maxDurationSeconds: 20 },
        { kind: "character_closing", maxDurationSeconds: 12 },
      ],
    },
    payload: {
      version: 1,
      transcriptExcerpt: "",
      hookShape: "Open directly on the saved character, move into illustrated story beats, and return to the character for the conclusion.",
      scriptGuidance: "Give the character concise opening and closing lines. Put narrative action and examples in the animated story beats.",
      visualNotes: [
        "Keep speaking beats direct-to-camera and identity locked.",
        "Alternate speaking and animated story beats without embedding tenant assets in the template.",
      ],
      pacing: { sceneCount: 5, avgSceneSec: 12, wordsPerMinute: 120 },
      captionStyle: "dynamic",
      energy: "cinematic, warm, story-led",
      sourceDurationSec: 60,
    },
  },
  {
    name: "Expert Explainer",
    summary: "You explain one thing properly while related footage plays above you. 90 seconds.",
    slots: [PRESENTER_SLOT, SCRIPT_SLOT, BRAND_KIT_SLOT, MUSIC_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      durationSec: 90,
      subtitles: true,
      captionStyle: "classic",
      visualsSource: "stock",
      stockSource: "auto",
    },
    payload: {
      version: 1,
      hookShape:
        "Open on the problem, not on yourself. A person visibly experiencing the thing you are about to explain fills the top of frame while you are already talking. No title card, no logo sting, and no credential until roughly ten seconds in.",
      pacing: { sceneCount: 12, avgSceneSec: 8, wordsPerMinute: 90 },
      captionStyle: "classic",
      energy: "calm, unhurried, authoritative without being stiff",
      visualNotes: [
        "One continuous take. The picture never cuts; only the overlay above you changes.",
        "Illustration occupies the top ~45% of frame, feathered into the plate rather than boxed.",
        "Alternate concept graphics with footage of real people doing the thing.",
        "Hold anything physical up into the blend zone so it reads at thumbnail size.",
        "Drop the overlay entirely before the closing line so it lands on your face.",
        "Keep the bottom eighth of frame clear for the platform's own UI.",
      ],
      scriptGuidance:
        "Name the symptom before the solution. Introduce the technique by fifteen seconds. Spend two thirds of the runtime on something the viewer can copy — show it, then show someone else doing it. Speak slowly, around three syllables a second; this format loses nothing by being unhurried and loses everything by sounding rushed. End on one instruction, not a summary.",
      sourceDurationSec: 90,
      transcriptExcerpt: "",
      creativeDirection: {
        version: 1,
        narrative: {
          hookStyle: "problem_first",
          tone: "authoritative",
          pacing: "measured",
          ctaStyle: "direct",
          requiredVocabulary: [],
          forbiddenVocabulary: ["follow for more"],
          evidenceRules: [
            { kind: "demonstration", instruction: "Show one technique the viewer can copy." },
          ],
        },
        structure: {
          sceneCount: { min: 8, max: 12 },
          beats: [
            { purpose: "hook", instruction: "Open on the viewer's problem.", weight: 1 },
            { purpose: "solution", instruction: "Explain and demonstrate the technique.", weight: 6 },
            { purpose: "cta", instruction: "End on one useful instruction.", weight: 1 },
          ],
        },
        visual: {
          style: "documentary",
          lighting: "natural",
          colorGrade: "natural",
          composition: "presenter_overlay",
          motion: "subtle",
          negativeTerms: ["title card", "logo sting"],
          subjectRule: "Keep the presenter unobscured and the lower eighth clear.",
          stockQueryGuidance: "Alternate concept graphics with real people performing the action.",
        },
        sonic: { mood: "calm", energy: 2, rhythm: "steady" },
        captions: { rhythm: "sentence", emphasis: "none" },
      },
    },
  },
  {
    name: "Quick Tip",
    summary: "One idea, one demonstration, out. 35 seconds.",
    slots: [PRESENTER_SLOT, SCRIPT_SLOT, BRAND_KIT_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      durationSec: 35,
      subtitles: true,
      captionStyle: "dynamic",
      visualsSource: "stock",
      stockSource: "auto",
    },
    payload: {
      version: 1,
      hookShape:
        "State the tip in the first sentence, with no preamble. The overlay arrives on the second sentence, not the first — a beat of just your face buys attention that a graphic spends.",
      pacing: { sceneCount: 4, avgSceneSec: 7, wordsPerMinute: 105 },
      captionStyle: "dynamic",
      energy: "brisk and direct, still warm",
      visualNotes: [
        "Four beats at most. A thirty-five second video with eight illustrations reads as frantic.",
        "Open with no overlay for the first three or four seconds.",
        "One graphic, one piece of real footage, one payoff.",
        "Word-group captions rather than sentences; the pace is too quick to read a full line.",
      ],
      scriptGuidance:
        "One idea only. Resist the second tip — it halves the impact of the first. Say the thing, show the thing, say why it works, stop. No sign-off, no 'follow for more'.",
      sourceDurationSec: 35,
      transcriptExcerpt: "",
      creativeDirection: {
        version: 1,
        narrative: {
          hookStyle: "direct_claim",
          tone: "conversational",
          pacing: "brisk",
          ctaStyle: "none",
          forbiddenVocabulary: ["follow for more"],
        },
        structure: {
          sceneCount: { min: 3, max: 4 },
          beats: [
            { purpose: "hook", instruction: "State the tip without preamble.", weight: 1 },
            { purpose: "demonstration", instruction: "Show the tip working.", weight: 2 },
            { purpose: "payoff", instruction: "Explain why it works and stop.", weight: 1 },
          ],
        },
        visual: {
          style: "natural",
          lighting: "natural",
          colorGrade: "vibrant",
          composition: "presenter_overlay",
          motion: "dynamic",
          subjectRule: "Begin on the unobscured presenter before introducing overlays.",
        },
        sonic: { mood: "optimistic", energy: 4, rhythm: "driving" },
        captions: { rhythm: "word_group", emphasis: "keywords" },
      },
    },
  },
  {
    name: "Myth vs Fact",
    summary: "Name a common belief, then dismantle it. 60 seconds.",
    slots: [PRESENTER_SLOT, SCRIPT_SLOT, BRAND_KIT_SLOT, MUSIC_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      durationSec: 60,
      subtitles: true,
      captionStyle: "classic",
      visualsSource: "stock",
      stockSource: "auto",
    },
    payload: {
      version: 1,
      hookShape:
        "State the myth flatly, as though you believe it, and let the overlay show the thing people picture when they hear it. The correction comes after — the pause between the two is what holds the viewer.",
      pacing: { sceneCount: 8, avgSceneSec: 7.5, wordsPerMinute: 95 },
      captionStyle: "classic",
      energy: "measured, faintly sceptical, never smug",
      visualNotes: [
        "Alternate registers: the myth illustrated with lifestyle footage, the correction with a graphic or data panel.",
        "Translucent overlay on the myth beats, near-solid on the correction beats — the visual weight tracks the argument.",
        "Bare frame on the sentence that actually corrects the belief.",
        "Avoid on-screen ticks, crosses and red circles; they read as clickbait and age badly.",
      ],
      scriptGuidance:
        "Give the myth its strongest form before you take it apart — a straw man loses the people who believed it. Correct once, with a reason, not three times. Close by telling them what to do instead, since a debunk without a replacement leaves nothing behind.",
      sourceDurationSec: 60,
      transcriptExcerpt: "",
      creativeDirection: {
        version: 1,
        narrative: {
          hookStyle: "myth_bust",
          tone: "skeptical",
          pacing: "measured",
          ctaStyle: "direct",
          evidenceRules: [
            { kind: "source", instruction: "Give the strongest form of the myth before correcting it." },
            { kind: "qualification", instruction: "Do not overstate what the correction proves." },
          ],
        },
        structure: {
          sceneCount: { min: 6, max: 8 },
          beats: [
            { purpose: "hook", instruction: "State the common belief plainly.", weight: 1 },
            { purpose: "evidence", instruction: "Correct it once with a reason.", weight: 3 },
            { purpose: "cta", instruction: "Give the viewer a practical replacement.", weight: 1 },
          ],
        },
        visual: {
          style: "editorial",
          lighting: "soft",
          colorGrade: "muted",
          composition: "presenter_overlay",
          motion: "subtle",
          negativeTerms: ["red circles", "ticks", "crosses", "clickbait"],
          stockQueryGuidance: "Use lifestyle footage for the myth and graphics or data for the correction.",
        },
        sonic: { mood: "tense", energy: 3, rhythm: "steady" },
        captions: { rhythm: "sentence", emphasis: "keywords" },
      },
    },
  },
  {
    name: "Product Walkthrough",
    summary: "Show the thing working, in your hands, step by step. 60 seconds.",
    slots: [PRESENTER_SLOT, SCRIPT_SLOT, BRAND_KIT_SLOT],
    jobDefaults: {
      aspectRatio: "9:16",
      durationSec: 60,
      subtitles: true,
      captionStyle: "classic",
      visualsSource: "stock",
      stockSource: "auto",
    },
    payload: {
      version: 1,
      hookShape:
        "The object is on screen in the first second, held, not described. Say what it is for before you say what it is.",
      pacing: { sceneCount: 7, avgSceneSec: 8, wordsPerMinute: 95 },
      captionStyle: "classic",
      energy: "practical and hands-on",
      visualNotes: [
        "Product beats sit near-solid; the object has to be legible at thumbnail size.",
        "Cut the overlay whenever your hands are doing something worth watching — the demonstration is the b-roll.",
        "One close detail shot per step, never a montage.",
        "End with the object at rest in frame rather than a logo card.",
      ],
      scriptGuidance:
        "Structure as steps the viewer will repeat, not features you want to list. Say what each step is for. Where a step is commonly done wrong, say so — that is the part people remember and share. Do not make claims about outcomes you cannot show.",
      sourceDurationSec: 60,
      transcriptExcerpt: "",
      creativeDirection: {
        version: 1,
        narrative: {
          hookStyle: "demonstration",
          tone: "authoritative",
          pacing: "measured",
          ctaStyle: "soft",
          evidenceRules: [
            { kind: "demonstration", instruction: "Show every outcome claimed by the script." },
          ],
        },
        structure: {
          sceneCount: { min: 5, max: 7 },
          beats: [
            { purpose: "hook", instruction: "Show the product in use immediately.", weight: 1 },
            { purpose: "demonstration", instruction: "Walk through repeatable steps.", weight: 4 },
            { purpose: "payoff", instruction: "End with the product at rest.", weight: 1 },
          ],
        },
        visual: {
          style: "commercial",
          lighting: "soft",
          colorGrade: "natural",
          composition: "close_detail",
          motion: "subtle",
          negativeTerms: ["montage", "logo card"],
          subjectRule: "Keep hands and product unobscured during each demonstrated step.",
          stockQueryGuidance: "Prefer a single close detail for each step.",
        },
        sonic: { mood: "optimistic", energy: 3, rhythm: "steady" },
        captions: { rhythm: "sentence", emphasis: "numbers" },
      },
    },
  },
];

/**
 * Provision each built-in KOKAO format once per database. An advisory
 * transaction lock prevents duplicate inserts if multiple API processes boot
 * concurrently. Existing rows are left untouched so publishing decisions and
 * administrator edits stay under superadmin control.
 */
export async function seedDefaultVideoTemplates(): Promise<void> {
  for (const template of DEFAULT_KOKAO_VIDEO_TEMPLATES) {
    assertTemplateSafe({
      tenantId: null,
      scope: "platform",
      sourceKind: "curated",
      sourceVideoPath: null,
      ...template,
    });
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1026001)`);
    const existing = await tx
      .select({ name: videoStyleProfilesTable.name })
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.scope, "platform"));
    const existingNames = new Set(existing.map((template) => template.name));
    const missing = DEFAULT_KOKAO_VIDEO_TEMPLATES.filter(
      (template) => !existingNames.has(template.name),
    );
    if (missing.length === 0) return;
    await tx.insert(videoStyleProfilesTable).values(
      missing.map((template) => ({
        tenantId: null,
        scope: "platform" as const,
        sourceKind: "curated" as const,
        published: true,
        ...template,
      })),
    );
  });
}