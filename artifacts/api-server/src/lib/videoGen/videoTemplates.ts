/**
 * Curated video templates, and the rules that keep them safe across tenants.
 *
 * A template is a format, never a video: overlay geometry, caption treatment,
 * beat rhythm, the structural arc. The tenant always brings the content — their
 * idea, their script, their face, their footage. If a template carried content,
 * every workspace would ship the same video, which social platforms punish and
 * audiences spot immediately.
 *
 * Templates and a workspace's own style profiles live in one table because
 * they are the same object with different owners. That keeps one picker and one
 * code path instead of two features that drift.
 *
 * The rule this module exists to enforce: a platform template may never
 * reference a tenant's assets. `characterId`, `brandKitId`, `styleProfileId`
 * and every `/objects/<tenantId>/...` path are meaningless in another
 * workspace, and a stale one either 404s or points at somebody else's file.
 * `TemplateJobDefaults` omits those keys so the mistake cannot be typed, and
 * `assertTemplateSafe` catches rows that predate the type or arrived from the
 * database.
 */

import type { TemplateSlot, TemplateSlotKind, VideoJobOptions } from "@workspace/db";

/**
 * Job option keys that only mean something inside one workspace.
 *
 * Kept as a runtime list as well as a type, because data loaded from the
 * database has no type to protect it.
 */
export const TENANT_SCOPED_OPTION_KEYS = [
  "characterId",
  "outfitId",
  "brandKitId",
  "styleProfileId",
  "sourceVideoPath",
  "musicPath",
  "suppliedPlan",
  "addedScenes",
] as const;

export type TenantScopedOptionKey = (typeof TENANT_SCOPED_OPTION_KEYS)[number];

/**
 * What a template is allowed to preset.
 *
 * Everything a format legitimately decides — aspect, duration, shot count,
 * caption style, whether subtitles burn in — and nothing that belongs to a
 * particular workspace.
 */
export type TemplateJobDefaults = Partial<Omit<VideoJobOptions, TenantScopedOptionKey>>;

export class UnsafeTemplateError extends Error {
  constructor(
    message: string,
    public readonly keys: string[],
  ) {
    super(message);
    this.name = "UnsafeTemplateError";
  }
}

/** Anything the picker needs to decide whether a row is offerable. */
export interface TemplateRow {
  id: number;
  tenantId: number | null;
  scope: "platform" | "tenant";
  sourceKind: "reference" | "curated" | "post";
  published: boolean;
  name: string;
  slots: TemplateSlot[];
  jobDefaults: Record<string, unknown>;
  sourceVideoPath: string | null;
  payload: { transcriptExcerpt?: unknown } | null;
}

/**
 * Reject a platform row carrying workspace-scoped options.
 *
 * Throws rather than filtering, because a template that quietly renders with
 * somebody else's brand kit is worse than one that fails to load.
 */
export function assertTemplateSafe(
  row: Pick<
    TemplateRow,
    | "scope"
    | "tenantId"
    | "sourceKind"
    | "jobDefaults"
    | "sourceVideoPath"
    | "payload"
    | "name"
  >,
): void {
  if (row.scope !== "platform") return;

  const offenders = new Set<string>(
    TENANT_SCOPED_OPTION_KEYS.filter(
      (key) => row.jobDefaults[key] !== undefined && row.jobDefaults[key] !== null,
    ),
  );
  if (row.tenantId !== null) offenders.add("tenantId");
  if (row.sourceKind !== "curated") offenders.add("sourceKind");
  if (row.sourceVideoPath !== null && row.sourceVideoPath.trim().length > 0) {
    offenders.add("sourceVideoPath");
  }
  if (
    typeof row.payload?.transcriptExcerpt === "string" &&
    row.payload.transcriptExcerpt.trim().length > 0
  ) {
    offenders.add("payload.transcriptExcerpt");
  }

  const keys = [...offenders];
  if (keys.length > 0) {
    throw new UnsafeTemplateError(
      `Template "${row.name}" carries workspace-scoped data (${keys.join(", ")}). ` +
        `A curated template must declare slots the tenant fills instead.`,
      keys,
    );
  }
}

/**
 * The rows a workspace may pick from: its own, plus every published platform
 * template. Platform drafts stay invisible until a superadmin publishes them.
 */
export function visibleTemplates<T extends TemplateRow>(rows: readonly T[], tenantId: number): T[] {
  return rows.filter((row) => {
    if (row.scope === "platform") return row.published;
    return row.tenantId === tenantId;
  });
}

/** Inputs the tenant has already supplied, by slot kind. */
export type SuppliedSlots = Partial<Record<TemplateSlotKind, boolean>>;

/**
 * Required slots the tenant has not filled.
 *
 * Surfaced on the card *before* selection. A template that looks free and then
 * demands a shoot is the worst possible ordering — the tenant has already
 * committed by the time they find out.
 */
export function missingSlots(
  slots: readonly TemplateSlot[],
  supplied: SuppliedSlots,
): TemplateSlot[] {
  return slots.filter((slot) => slot.required && supplied[slot.kind] !== true);
}

export function canRender(slots: readonly TemplateSlot[], supplied: SuppliedSlots): boolean {
  return missingSlots(slots, supplied).length === 0;
}

/**
 * Video units a template will cost per run, for the card.
 *
 * An estimate for display, not the authoritative charge — the route still
 * computes the reservation from engine and options at enqueue time. It exists
 * because a template that quietly costs eight units every run generates
 * support tickets, and the tenant should see that before clicking.
 */
export function estimateVideoUnits(jobDefaults: Record<string, unknown>): number {
  const shotCount = Number(jobDefaults.shotCount);
  // Slideshow and presenter formats are a single encode; AI shot generation is
  // priced per shot, which is where a template can quietly get expensive.
  let units = Number.isInteger(shotCount) && shotCount > 0 ? shotCount : 1;
  // A composed music bed is generated, so it costs one on top.
  if (typeof jobDefaults.musicPrompt === "string" && jobDefaults.musicPrompt.trim().length > 0) {
    units += 1;
  }
  return units;
}

/** Human-readable slot requirements, in the order they should be shown. */
export const SLOT_LABELS: Readonly<Record<TemplateSlotKind, string>> = {
  presenter_video: "A take of you talking to camera",
  script: "Your script or topic",
  brand_kit: "A brand kit",
  character: "A saved character",
  music: "A music track",
  logo: "Your logo",
};

/**
 * The slot every presenter-overlay format needs, with the framing constraint
 * that actually matters.
 *
 * The overlay occupies the top of the frame, so footage shot selfie-close puts
 * a graphic across the speaker's face. Stating the framing on the card is
 * cheaper than rejecting the upload afterwards.
 */
export const PRESENTER_SLOT: TemplateSlot = {
  kind: "presenter_video",
  required: true,
  label: SLOT_LABELS.presenter_video,
  hint: "60–90 seconds, one continuous take, head and shoulders in the lower two-thirds of frame so the overlay has room above you.",
};