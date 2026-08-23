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
import { videoJobUnits } from "./units";

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
  "presenterVideoPath",
  "musicPath",
  "suppliedPlan",
  "addedScenes",
  "presenterBroll",
] as const;

export type TenantScopedOptionKey = (typeof TENANT_SCOPED_OPTION_KEYS)[number];

/**
 * The complete persisted surface for a topic-video format. Keeping this as an
 * allowlist matters more than merely denying today's known tenant keys: an
 * unknown nested object could otherwise carry a workspace path or id and be
 * returned to every tenant before this module knew that key existed.
 */
export const TEMPLATE_JOB_DEFAULT_KEYS = [
  "aspectRatio",
  "durationSec",
  "shotCount",
  "subtitles",
  "captionStyle",
  "paragraphCount",
  "visualsSource",
  "stockSource",
  "scriptVariant",
  "reviewStoryboard",
] as const;
/**
 * What a template is allowed to preset.
 *
 * Everything a format legitimately decides — aspect, duration, shot count,
 * caption style, whether subtitles burn in — and nothing that belongs to a
 * particular workspace.
 */
export type TemplateJobDefaults = Partial<Pick<VideoJobOptions, TemplateJobDefaultKey>>;

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

function invalidTemplateJobDefaultKeys(jobDefaults: Record<string, unknown>): string[] {
  const invalid = new Set(
    Object.keys(jobDefaults).filter(
      (key) => !(TEMPLATE_JOB_DEFAULT_KEYS as readonly string[]).includes(key),
    ),
  );
  const aspectRatio = jobDefaults.aspectRatio;
  if (
    aspectRatio !== undefined &&
    aspectRatio !== "16:9" &&
    aspectRatio !== "9:16" &&
    aspectRatio !== "1:1"
  ) {
    invalid.add("aspectRatio");
  }
  const durationSec = jobDefaults.durationSec;
  if (
    durationSec !== undefined &&
    (!Number.isInteger(durationSec) || Number(durationSec) < 3 || Number(durationSec) > 30)
  ) {
    invalid.add("durationSec");
  }
  const shotCount = jobDefaults.shotCount;
  if (
    shotCount !== undefined &&
    (!Number.isInteger(shotCount) || Number(shotCount) < 1 || Number(shotCount) > 10)
  ) {
    invalid.add("shotCount");
  }
  if (jobDefaults.subtitles !== undefined && typeof jobDefaults.subtitles !== "boolean") {
    invalid.add("subtitles");
  }
  const captionStyle = jobDefaults.captionStyle;
  if (
    captionStyle !== undefined &&
    captionStyle !== "classic" &&
    captionStyle !== "dynamic"
  ) {
    invalid.add("captionStyle");
  }
  const paragraphCount = jobDefaults.paragraphCount;
  if (
    paragraphCount !== undefined &&
    (!Number.isInteger(paragraphCount) ||
      Number(paragraphCount) < 1 ||
      Number(paragraphCount) > 3)
  ) {
    invalid.add("paragraphCount");
  }
  const visualsSource = jobDefaults.visualsSource;
  if (
    visualsSource !== undefined &&
    visualsSource !== "stock" &&
    visualsSource !== "character" &&
    visualsSource !== "ai" &&
    visualsSource !== "ai_video"
  ) {
    invalid.add("visualsSource");
  }
  const stockSource = jobDefaults.stockSource;
  if (
    stockSource !== undefined &&
    stockSource !== "auto" &&
    stockSource !== "pexels" &&
    stockSource !== "pixabay" &&
    stockSource !== "wikimedia"
  ) {
    invalid.add("stockSource");
  }
  if (
    jobDefaults.scriptVariant !== undefined &&
    (typeof jobDefaults.scriptVariant !== "string" ||
      jobDefaults.scriptVariant.trim().length === 0 ||
      jobDefaults.scriptVariant.length > 64)
  ) {
    invalid.add("scriptVariant");
  }
  if (
    jobDefaults.reviewStoryboard !== undefined &&
    typeof jobDefaults.reviewStoryboard !== "boolean"
  ) {
    invalid.add("reviewStoryboard");
  }
  return [...invalid];
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

  const offenders = new Set<string>(invalidTemplateJobDefaultKeys(row.jobDefaults));
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
      `Template "${row.name}" carries unsafe or unsupported defaults (${keys.join(", ")}). ` +
        `A curated template must use supported format settings and declare tenant inputs as slots.`,
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
  const defaults = jobDefaults as TemplateJobDefaults;
  return videoJobUnits("topic_to_video", {
    ...defaults,
    aspectRatio: defaults.aspectRatio ?? "9:16",
  });
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

export type TemplateJobDefaultKey = (typeof TEMPLATE_JOB_DEFAULT_KEYS)[number];
