import { pgTable, text, serial, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

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
}

export const videoStyleProfilesTable = pgTable("video_style_profiles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  /** /objects/... path of the analyzed reference, if it is still around. */
  sourceVideoPath: text("source_video_path"),
  payload: jsonb("payload").$type<VideoStyleProfilePayload>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VideoStyleProfile = typeof videoStyleProfilesTable.$inferSelect;
