import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Reusable AI characters for the Video Studio. A character is an identity —
 * a name, an appearance description, and a canonical full-body reference
 * image — that video engines anchor generation to so the same person appears
 * across scenes and videos ("character lock").
 *
 * Costumes are modeled as outfits: each outfit is an identity-preserving
 * image edit of the character's reference wearing different clothes. Locking
 * an outfit pins the wardrobe for a whole video; story videos may switch
 * outfits between scenes ("costume change").
 */

export const charactersTable = pgTable("characters", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  /** Appearance description used in generation prompts. */
  description: text("description").notNull().default(""),
  /** Canonical full-body reference image (/objects/<tenantId>/uploads/...). */
  referenceImagePath: text("reference_image_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const characterOutfitsTable = pgTable("character_outfits", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  characterId: integer("character_id").notNull(),
  name: text("name").notNull(),
  /** Costume description used in generation prompts. */
  description: text("description").notNull(),
  /** The character wearing this outfit (/objects/<tenantId>/uploads/...). */
  referenceImagePath: text("reference_image_path").notNull(),
  /** The outfit used when a video doesn't pick one explicitly. */
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export interface PresetStockVoice {
  id: string;
  provider: "openai";
  model: "gpt-audio";
  speaker: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  label: string;
  license: string;
  languages: string[];
}

/** Platform-owned fictional identities. Assets are public, curated references. */
export const presetCharactersTable = pgTable(
  "preset_characters",
  {
    id: serial("id").primaryKey(),
    /** Permanent API identity; unlike the display name this must never change. */
    stableId: text("stable_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    referenceImagePath: text("reference_image_path").notNull(),
    supportedLanguages: jsonb("supported_languages").$type<string[]>().notNull(),
    voices: jsonb("voices").$type<PresetStockVoice[]>().notNull(),
    defaultOutfitName: text("default_outfit_name").notNull(),
    defaultOutfitDescription: text("default_outfit_description").notNull(),
    defaultOutfitReferenceImagePath: text("default_outfit_reference_image_path").notNull(),
    genreTags: jsonb("genre_tags").$type<string[]>().notNull(),
    usageGuidance: text("usage_guidance").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("preset_characters_stable_id_uniq").on(table.stableId),
    uniqueIndex("preset_characters_sort_order_uniq").on(table.sortOrder),
  ],
);

/**
 * A tenant-funded outfit edit of a preset. Preview rows are intentionally
 * durable: approval only changes metadata, and reuse never calls a provider.
 */
export const presetOutfitDerivativesTable = pgTable(
  "preset_outfit_derivatives",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    presetCharacterId: integer("preset_character_id")
      .notNull()
      .references(() => presetCharactersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    referenceImagePath: text("reference_image_path").notNull(),
    status: text("status").$type<"preview" | "approved">().notNull().default("preview"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("preset_outfit_derivatives_tenant_id_id_uniq").on(table.tenantId, table.id),
  ],
);

export type Character = typeof charactersTable.$inferSelect;
export type CharacterOutfit = typeof characterOutfitsTable.$inferSelect;
export type PresetCharacter = typeof presetCharactersTable.$inferSelect;
export type PresetOutfitDerivative = typeof presetOutfitDerivativesTable.$inferSelect;
