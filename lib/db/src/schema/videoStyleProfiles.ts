import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { CreativeDirection } from "./creativeDirection";
import type {
  VideoDurationMode,
  VideoScriptDetailLevel,
  VideoVisualStrategy,
} from "./videoGenerations";

/**
 * Reusable "make it like this" style profiles for the Video Studio.
 *
 * A tenant uploads a reference video they like; the analyzer measures what is
 * measurable (duration, scene count, words per minute) and asks a vision model
 * to describe the rest (hook shape, energy, caption treatment). The result is
 * a small versioned JSON payload that a topic video can be generated against —
 * so "same pacing and hook as that video that worked" becomes a picklist entry
 * instead of a prompt the user has to rewrite every time.
 *
 * Style profiles never carry the reference's footage, audio, or wording into a
 * generated video: only the structural description is stored and reused.
 *
 * The same table also holds PLATFORM templates — the curated formats a
 * superadmin publishes for every workspace to start from. A template and a
 * tenant's own style profile are the same thing pointed at different owners,
 * so they share one table and one picker rather than drifting apart as two
 * half-features. `scope` says which: a platform row has no `tenantId`.
 *
 * A platform row may never reference a tenant's assets. `characterId`,
 * `brandKitId` and every `/objects/<tenantId>/...` path mean nothing — or
 * something belonging to somebody else — in another workspace, so a template
 * declares SLOTS the tenant fills at generation time instead. The
 * `TemplateJobDefaults` type omits those fields outright so the mistake cannot
 * be typed in the first place.
 */

/** Caption treatment observed in the reference, mapped to our composer. */
export type VideoStyleCaptionStyle = "classic" | "dynamic" | "none";

/** Versioned analysis payload. Bump `version` when the shape changes. */
export interface VideoStyleProfilePayload {
  version: 1;
  /** How the first ~3 seconds grab attention ("question to camera", ...). */
  hookShape: string;
  pacing: {
    /** Distinct visual scenes counted across the sampled frames. */
    sceneCount: number;
    /** Mean seconds per scene, derived from duration / sceneCount. */
    avgSceneSec: number;
    /** Narration speed, measured from the transcript (0 = no speech found). */
    wordsPerMinute: number;
  };
  captionStyle: VideoStyleCaptionStyle;
  /** Overall feel in a word or two ("calm", "high-energy", ...). */
  energy: string;
  /** Short observations about framing, colour, motion, text placement. */
  visualNotes: string[];
  /** Instructions for the script writer, in the analyzer's own words. */
  scriptGuidance: string;
  sourceDurationSec: number;
  /** First few hundred characters of the transcript, for the UI preview. */
  transcriptExcerpt: string;
  /** Structured, portable creative intent. Absent on legacy rows. */
  creativeDirection?: CreativeDirection;
}

/** Who a row belongs to. Platform rows are curated; tenant rows are derived. */
export type VideoStyleScope = "platform" | "tenant";

/** Where a row came from, which drives how it is labelled in the picker. */
export type VideoStyleSource = "reference" | "curated" | "post";

/** An input the tenant must supply before a template can render. */
export type TemplateSlotKind =
  | "presenter_video"
  | "script"
  | "brand_kit"
  | "character"
  | "saved_character"
  | "music"
  | "logo";

export interface TemplateSlot {
  kind: TemplateSlotKind;
  required: boolean;
  /** Shown on the card BEFORE selection, so nothing demands a shoot after the fact. */
  label: string;
  /** Concrete guidance, e.g. framing a plate has to satisfy. */
  hint?: string;
}

/** Persisted, tenant-portable long-form controls accepted in jobDefaults. */
export interface VideoTemplateSettings {
  durationMode?: VideoDurationMode;
  maxDurationSeconds?: number;
  speakingRateWpm?: number;
  scriptDetailLevel?: VideoScriptDetailLevel;
  minSceneDurationSeconds?: number;
  maxSceneDurationSeconds?: number;
  minSceneCount?: number;
  maxSceneCount?: number;
  visualStrategy?: VideoVisualStrategy;
  /** Legacy maximum; only used when maxDurationSeconds is absent. */
  durationSec?: number;
  /**
   * A portable mixed-story format. This is deliberately structural: it names
   * roles and bounded durations, never a character, voice, or storage object.
   */
  format?: "standard" | "hybrid_character_story";
  hybridBeatPattern?: HybridStoryBeatPattern[];
}

export type HybridStoryBeatKind =
  | "character_opening"
  | "story_animation"
  | "character_interlude"
  | "character_closing";

export interface HybridStoryBeatPattern {
  kind: HybridStoryBeatKind;
  /** Upper duration bound for this role. Actual duration comes from narration. */
  maxDurationSeconds: number;
}

export const videoStyleProfilesTable = pgTable(
  "video_style_profiles",
  {
    id: serial("id").primaryKey(),
    /** Null on platform templates, which belong to no workspace. */
    tenantId: integer("tenant_id"),
    scope: text("scope").$type<VideoStyleScope>().notNull().default("tenant"),
    sourceKind: text("source_kind").$type<VideoStyleSource>().notNull().default("reference"),
    /** Platform rows stay hidden until a superadmin publishes them. */
    published: boolean("published").notNull().default(false),
    name: text("name").notNull(),
    /** One line under the name in the picker. */
    summary: text("summary"),
    /** Inputs the tenant must supply. Empty for a plain derived style profile. */
    slots: jsonb("slots").$type<TemplateSlot[]>().notNull().default([]),
    /**
     * Job options this template presets. Typed to exclude every tenant-scoped
     * field, so a curated template cannot carry another workspace's assets.
     */
    jobDefaults: jsonb("job_defaults").$type<Record<string, unknown>>().notNull().default({}),
    /** /objects/... path of the analyzed reference, if it is still around. */
    sourceVideoPath: text("source_video_path"),
    payload: jsonb("payload").$type<VideoStyleProfilePayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "video_style_profiles_scope_owner_safe",
      sql`
        (
          ${table.scope} = 'tenant'
          AND ${table.tenantId} IS NOT NULL
        )
        OR
        (
          ${table.scope} = 'platform'
          AND ${table.tenantId} IS NULL
          AND ${table.sourceKind} = 'curated'
          AND ${table.sourceVideoPath} IS NULL
          AND COALESCE(${table.payload}->>'transcriptExcerpt', '') = ''
        )
      `,
    ),
  ],
);

export type VideoStyleProfile = typeof videoStyleProfilesTable.$inferSelect;
