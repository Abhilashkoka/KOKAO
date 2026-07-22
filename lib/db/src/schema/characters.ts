import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";

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

export type Character = typeof charactersTable.$inferSelect;
export type CharacterOutfit = typeof characterOutfitsTable.$inferSelect;
