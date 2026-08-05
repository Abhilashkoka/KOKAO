import { pgTable, serial, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Per-provider video API mapping. Custom providers' video APIs rarely copy
 * OpenRouter's shape, so the admin either picks the "openrouter" template
 * (default when null) or fills in a "custom" mapping: endpoint paths plus
 * JSON field paths (dot notation) that tell the generic adapter where to put
 * request fields and where to find the job id / status / video URL in
 * responses. Validation lives in customAiProviders.ts
 * (validateVideoApiMapping) — keep the two in lockstep.
 */
export interface CustomVideoApiMapping {
  /** "openrouter" = built-in OpenRouter-shaped async API; "custom" = mapped. */
  template: "openrouter" | "custom";
  /** Submit endpoint path appended to baseUrl, e.g. "/videos" (custom only). */
  submitPath?: string;
  /** Poll path with "{id}" placeholder, e.g. "/videos/{id}". Empty = the
   * submit response is synchronous and already carries the video URL. */
  pollPath?: string;
  /** Request body field (dot path) for the prompt. Required for custom. */
  promptField?: string;
  /** Request body field for the model name. Empty = omit model. */
  modelField?: string;
  /** Request body field for the clip duration in seconds. Empty = omit. */
  durationField?: string;
  /** Request body field for the aspect ratio ("16:9" etc). Empty = omit. */
  aspectRatioField?: string;
  /** Request body field for the start image as a data URL. Empty = text-only. */
  imageField?: string;
  /** Response path to the job id (required when pollPath is set). */
  jobIdPath?: string;
  /** Response path to the job status (required when pollPath is set). */
  statusPath?: string;
  /** Status values that mean "still working" (default OpenRouter's set). */
  pendingValues?: string[];
  /** Status value that means success (default "completed"). */
  completedValue?: string;
  /** Response path to the video URL (string or array of strings). Required. */
  videoUrlPath?: string;
  /** Response path to a human-readable error detail. Optional. */
  errorPath?: string;
}

/**
 * Admin-added OpenAI-compatible AI providers (superadmin only).
 *
 * A row here makes the provider selectable in the existing per-use-case
 * settings (text/captions, image generation, video generation) under the
 * provider id "custom:<id>" — no code change or deploy needed to onboard a
 * new vendor, as long as it speaks the OpenAI-compatible API surface:
 *   - text/captions: POST {baseUrl}/chat/completions
 *   - image:         POST {baseUrl}/images/generations
 *   - video:         OpenRouter-shaped async API (POST {baseUrl}/videos,
 *                    poll GET {baseUrl}/videos/{id}, download unsigned_urls)
 *
 * The per-use-case toggles gate WHERE the provider may be selected; models
 * are entered in each use case's own settings card (exactly like the
 * built-in providers), and pricing goes through the same activation gate —
 * unknown models need a manual price row before they can be activated.
 *
 * The API key is encrypted at rest (secretCrypto) and nullable: self-hosted
 * endpoints may be keyless.
 */
export const customAiProvidersTable = pgTable("custom_ai_providers", {
  id: serial("id").primaryKey(),
  /** Label shown in every provider dropdown. */
  name: text("name").notNull(),
  /** OpenAI-compatible API root, e.g. https://api.together.xyz/v1 (https only). */
  baseUrl: text("base_url").notNull(),
  /** encryptJson({ apiKey }) — null for keyless endpoints. */
  encryptedApiKey: text("encrypted_api_key"),
  textEnabled: boolean("text_enabled").notNull().default(false),
  imageEnabled: boolean("image_enabled").notNull().default(false),
  videoEnabled: boolean("video_enabled").notNull().default(false),
  /** How the provider's video API is shaped. Null = OpenRouter template. */
  videoApi: jsonb("video_api").$type<CustomVideoApiMapping>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CustomAiProvider = typeof customAiProvidersTable.$inferSelect;
