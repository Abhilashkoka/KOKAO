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

import {
  CREATIVE_DIRECTION_LIMITS,
  type CreativeDirection,
  type CreativeDirectionProvenanceEntry,
  type CreativeDirectionSourceKind,
  type ResolvedCreativeBrief,
  type TemplateSlot,
  type TemplateSlotKind,
  type VideoJobOptions,
} from "@workspace/db";
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

export class CreativeDirectionConflictError extends Error {
  constructor(
    message: string,
    public readonly conflicts: string[],
  ) {
    super(message);
    this.name = "CreativeDirectionConflictError";
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
  payload: {
    transcriptExcerpt?: unknown;
    creativeDirection?: unknown;
    hookShape?: unknown;
    scriptGuidance?: unknown;
    visualNotes?: unknown;
    pacing?: unknown;
    captionStyle?: unknown;
  } | null;
}

const ENUMS = {
  hookStyle: ["direct_claim", "question", "problem_first", "demonstration", "myth_bust", "story"],
  tone: ["authoritative", "conversational", "warm", "playful", "urgent", "inspirational", "skeptical"],
  pacing: ["slow", "measured", "brisk", "rapid"],
  ctaStyle: ["none", "soft", "direct"],
  beatPurpose: ["hook", "context", "problem", "demonstration", "evidence", "solution", "payoff", "cta"],
  evidenceKind: ["demonstration", "example", "source", "data", "qualification"],
  visualStyle: ["documentary", "editorial", "cinematic", "commercial", "graphic", "natural"],
  lighting: ["natural", "soft", "high_key", "low_key", "dramatic"],
  colorGrade: ["natural", "warm", "cool", "vibrant", "muted", "high_contrast"],
  composition: ["centered", "rule_of_thirds", "close_detail", "wide_context", "presenter_overlay"],
  motion: ["locked", "subtle", "handheld", "dynamic"],
  sonicMood: ["none", "calm", "optimistic", "playful", "dramatic", "tense"],
  rhythm: ["sparse", "steady", "driving"],
  captionRhythm: ["sentence", "phrase", "word_group"],
  captionEmphasis: ["none", "keywords", "numbers"],
} as const;

function normalizedTerm(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function unsafeCreativeValues(value: unknown, path = "creativeDirection"): string[] {
  if (typeof value === "string") {
    return /(?:^|\/)objects(?:\/|$)/i.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unsafeCreativeValues(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    const keyUnsafe = /^(?:tenant|character|outfit|brandKit|styleProfile|asset|upload)Id$/i.test(key)
      ? [childPath]
      : [];
    return [...keyUnsafe, ...unsafeCreativeValues(child, childPath)];
  });
}

function stringIssue(value: unknown, path: string, max: number, issues: string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    issues.push(path);
  }
}

function enumIssue(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: string[],
): void {
  if (value !== undefined && !allowed.includes(value as string)) issues.push(path);
}

function stringListIssues(
  value: unknown,
  path: string,
  maxItems: number,
  maxChars: number,
  issues: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maxItems) {
    issues.push(path);
    return;
  }
  value.forEach((item, index) => stringIssue(item, `${path}[${index}]`, maxChars, issues));
}

function unknownKeyIssues(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key}`);
  }
}

/**
 * Runtime validation for database/admin input. Paths are returned instead of a
 * boolean so publishing and authoring UIs can explain exactly what is unsafe.
 */
export function validateCreativeDirection(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["creativeDirection"];
  const direction = value as Record<string, any>;
  const issues = unsafeCreativeValues(direction);
  if (direction.version !== 1) issues.push("creativeDirection.version");
  unknownKeyIssues(direction, "creativeDirection", ["version", "narrative", "structure", "visual", "sonic", "captions"], issues);

  const narrative = direction.narrative;
  if (narrative !== undefined && (!narrative || typeof narrative !== "object" || Array.isArray(narrative))) {
    issues.push("creativeDirection.narrative");
  } else if (narrative) {
    unknownKeyIssues(narrative, "creativeDirection.narrative", ["hookStyle", "tone", "pacing", "ctaStyle", "guidance", "requiredVocabulary", "forbiddenVocabulary", "evidenceRules"], issues);
    enumIssue(narrative.hookStyle, "creativeDirection.narrative.hookStyle", ENUMS.hookStyle, issues);
    enumIssue(narrative.tone, "creativeDirection.narrative.tone", ENUMS.tone, issues);
    enumIssue(narrative.pacing, "creativeDirection.narrative.pacing", ENUMS.pacing, issues);
    enumIssue(narrative.ctaStyle, "creativeDirection.narrative.ctaStyle", ENUMS.ctaStyle, issues);
    stringIssue(narrative.guidance, "creativeDirection.narrative.guidance", CREATIVE_DIRECTION_LIMITS.proseChars, issues);
    stringListIssues(narrative.requiredVocabulary, "creativeDirection.narrative.requiredVocabulary", CREATIVE_DIRECTION_LIMITS.vocabularyItems, CREATIVE_DIRECTION_LIMITS.vocabularyItemChars, issues);
    stringListIssues(narrative.forbiddenVocabulary, "creativeDirection.narrative.forbiddenVocabulary", CREATIVE_DIRECTION_LIMITS.vocabularyItems, CREATIVE_DIRECTION_LIMITS.vocabularyItemChars, issues);
    if (narrative.evidenceRules !== undefined) {
      if (!Array.isArray(narrative.evidenceRules) || narrative.evidenceRules.length > CREATIVE_DIRECTION_LIMITS.evidenceRules) {
        issues.push("creativeDirection.narrative.evidenceRules");
      } else {
        narrative.evidenceRules.forEach((rule: any, index: number) => {
          unknownKeyIssues(rule, `creativeDirection.narrative.evidenceRules[${index}]`, ["kind", "instruction"], issues);
          enumIssue(rule?.kind, `creativeDirection.narrative.evidenceRules[${index}].kind`, ENUMS.evidenceKind, issues);
          stringIssue(rule?.instruction, `creativeDirection.narrative.evidenceRules[${index}].instruction`, CREATIVE_DIRECTION_LIMITS.shortProseChars, issues);
        });
      }
    }
    const required = new Set(
      (Array.isArray(narrative.requiredVocabulary) ? narrative.requiredVocabulary : [])
        .filter((term: unknown): term is string => typeof term === "string")
        .map(normalizedTerm),
    );
    for (const term of Array.isArray(narrative.forbiddenVocabulary) ? narrative.forbiddenVocabulary : []) {
      if (typeof term === "string" && required.has(normalizedTerm(term))) {
        issues.push(`creativeDirection.narrative.vocabularyConflict:${term.trim()}`);
      }
    }
  }

  const structure = direction.structure;
  if (structure !== undefined && (!structure || typeof structure !== "object" || Array.isArray(structure))) {
    issues.push("creativeDirection.structure");
  }
  unknownKeyIssues(structure, "creativeDirection.structure", ["sceneCount", "beats"], issues);
  if (structure?.sceneCount !== undefined) {
    const { min, max } = structure.sceneCount ?? {};
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > CREATIVE_DIRECTION_LIMITS.scenes || min > max) {
      issues.push("creativeDirection.structure.sceneCount");
    }
  }
  if (structure?.beats !== undefined) {
    if (!Array.isArray(structure.beats) || structure.beats.length > CREATIVE_DIRECTION_LIMITS.beats) {
      issues.push("creativeDirection.structure.beats");
    } else {
      structure.beats.forEach((beat: any, index: number) => {
        unknownKeyIssues(beat, `creativeDirection.structure.beats[${index}]`, ["purpose", "instruction", "weight"], issues);
        enumIssue(beat?.purpose, `creativeDirection.structure.beats[${index}].purpose`, ENUMS.beatPurpose, issues);
        stringIssue(beat?.instruction, `creativeDirection.structure.beats[${index}].instruction`, CREATIVE_DIRECTION_LIMITS.shortProseChars, issues);
        if (beat?.weight !== undefined && (typeof beat.weight !== "number" || beat.weight <= 0 || beat.weight > 10)) {
          issues.push(`creativeDirection.structure.beats[${index}].weight`);
        }
      });
    }
  }

  const visual = direction.visual;
  if (visual !== undefined && (!visual || typeof visual !== "object" || Array.isArray(visual))) {
    issues.push("creativeDirection.visual");
  } else if (visual) {
    unknownKeyIssues(visual, "creativeDirection.visual", ["style", "lighting", "colorGrade", "composition", "motion", "palette", "negativeTerms", "subjectRule", "stockQueryGuidance"], issues);
    enumIssue(visual.style, "creativeDirection.visual.style", ENUMS.visualStyle, issues);
    enumIssue(visual.lighting, "creativeDirection.visual.lighting", ENUMS.lighting, issues);
    enumIssue(visual.colorGrade, "creativeDirection.visual.colorGrade", ENUMS.colorGrade, issues);
    enumIssue(visual.composition, "creativeDirection.visual.composition", ENUMS.composition, issues);
    enumIssue(visual.motion, "creativeDirection.visual.motion", ENUMS.motion, issues);
    stringListIssues(visual.palette, "creativeDirection.visual.palette", CREATIVE_DIRECTION_LIMITS.paletteItems, CREATIVE_DIRECTION_LIMITS.vocabularyItemChars, issues);
    stringListIssues(visual.negativeTerms, "creativeDirection.visual.negativeTerms", CREATIVE_DIRECTION_LIMITS.negativeTerms, CREATIVE_DIRECTION_LIMITS.vocabularyItemChars, issues);
    stringIssue(visual.subjectRule, "creativeDirection.visual.subjectRule", CREATIVE_DIRECTION_LIMITS.shortProseChars, issues);
    stringIssue(visual.stockQueryGuidance, "creativeDirection.visual.stockQueryGuidance", CREATIVE_DIRECTION_LIMITS.shortProseChars, issues);
  }
  const sonic = direction.sonic;
  if (sonic !== undefined && (!sonic || typeof sonic !== "object" || Array.isArray(sonic))) {
    issues.push("creativeDirection.sonic");
  } else if (sonic) {
    unknownKeyIssues(sonic, "creativeDirection.sonic", ["mood", "energy", "rhythm", "guidance"], issues);
    enumIssue(sonic.mood, "creativeDirection.sonic.mood", ENUMS.sonicMood, issues);
    enumIssue(sonic.rhythm, "creativeDirection.sonic.rhythm", ENUMS.rhythm, issues);
    if (sonic.energy !== undefined && (!Number.isInteger(sonic.energy) || sonic.energy < 1 || sonic.energy > 5)) issues.push("creativeDirection.sonic.energy");
    stringIssue(sonic.guidance, "creativeDirection.sonic.guidance", CREATIVE_DIRECTION_LIMITS.shortProseChars, issues);
  }
  if (direction.captions !== undefined && (!direction.captions || typeof direction.captions !== "object" || Array.isArray(direction.captions))) {
    issues.push("creativeDirection.captions");
  } else if (direction.captions) {
    unknownKeyIssues(direction.captions, "creativeDirection.captions", ["rhythm", "emphasis"], issues);
    enumIssue(direction.captions.rhythm, "creativeDirection.captions.rhythm", ENUMS.captionRhythm, issues);
    enumIssue(direction.captions.emphasis, "creativeDirection.captions.emphasis", ENUMS.captionEmphasis, issues);
  }
  return [...new Set(issues)];
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
    aspectRatio !== "1:1" &&
    aspectRatio !== "4:5" &&
    aspectRatio !== "4:3" &&
    aspectRatio !== "3:4" &&
    aspectRatio !== "21:9"
  ) {
    invalid.add("aspectRatio");
  }
  const durationSec = jobDefaults.durationSec;
  if (
    durationSec !== undefined &&
    (!Number.isInteger(durationSec) || Number(durationSec) < 3 || Number(durationSec) > 600)
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
  if (row.payload?.creativeDirection !== undefined) {
    for (const issue of validateCreativeDirection(row.payload.creativeDirection)) {
      offenders.add(issue);
    }
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

function boundedLegacyText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim().slice(0, max);
}

/**
 * Directionless rows are converted from settings the old pipeline already
 * understood. No template name is interpreted and no new content is invented.
 */
export function legacyFormatCreativeDirection(
  jobDefaults: Record<string, unknown>,
  payload?: TemplateRow["payload"],
): CreativeDirection {
  const duration = typeof jobDefaults.durationSec === "number" ? jobDefaults.durationSec : undefined;
  const payloadPacing =
    payload?.pacing && typeof payload.pacing === "object"
      ? (payload.pacing as Record<string, unknown>)
      : undefined;
  const rawScenes =
    typeof jobDefaults.shotCount === "number"
      ? jobDefaults.shotCount
      : typeof payloadPacing?.sceneCount === "number"
        ? payloadPacing.sceneCount
        : undefined;
  const sceneCount =
    rawScenes === undefined
      ? undefined
      : Math.max(1, Math.min(CREATIVE_DIRECTION_LIMITS.scenes, Math.round(rawScenes)));
  const guidance = [boundedLegacyText(payload?.hookShape, 240), boundedLegacyText(payload?.scriptGuidance, 560)]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .slice(0, CREATIVE_DIRECTION_LIMITS.proseChars) || undefined;
  const captionStyle = jobDefaults.captionStyle ?? payload?.captionStyle;

  return {
    version: 1,
    narrative: {
      ...(duration !== undefined
        ? { pacing: duration <= 40 ? "brisk" as const : duration >= 120 ? "slow" as const : "measured" as const }
        : {}),
      ...(guidance ? { guidance } : {}),
    },
    ...(sceneCount ? { structure: { sceneCount: { min: sceneCount, max: sceneCount } } } : {}),
    ...(captionStyle === "dynamic"
      ? { captions: { rhythm: "word_group" as const, emphasis: "keywords" as const } }
      : captionStyle === "classic"
        ? { captions: { rhythm: "sentence" as const, emphasis: "none" as const } }
        : {}),
  };
}

export interface ResolveCreativeBriefInput {
  jobDefaults: Record<string, unknown>;
  legacyPayload?: TemplateRow["payload"];
  template?: CreativeDirection | null;
  vertical?: CreativeDirection | null;
  brand?: CreativeDirection | null;
  user?: CreativeDirection | null;
  topic?: string;
  references?: Partial<Record<CreativeDirectionSourceKind, string>>;
}

const UNION_LIST_PATHS = new Map<string, number>([
  ["narrative.requiredVocabulary", CREATIVE_DIRECTION_LIMITS.vocabularyItems],
  ["narrative.forbiddenVocabulary", CREATIVE_DIRECTION_LIMITS.vocabularyItems],
  ["narrative.evidenceRules", CREATIVE_DIRECTION_LIMITS.evidenceRules],
  ["visual.palette", CREATIVE_DIRECTION_LIMITS.paletteItems],
  ["visual.negativeTerms", CREATIVE_DIRECTION_LIMITS.negativeTerms],
]);

function unionKey(value: unknown): string {
  return typeof value === "string" ? normalizedTerm(value) : JSON.stringify(value);
}

/**
 * Resolve low-to-high precedence: format, template, vertical, brand, user.
 * Scalars and ordered beats use the later source. Portable lists are stable
 * unions and are capped. Scene ranges intersect so a later preference cannot
 * escape an earlier format/vertical constraint.
 */
export function resolveCreativeBrief(input: ResolveCreativeBriefInput): ResolvedCreativeBrief {
  const layers: Array<{ source: CreativeDirectionSourceKind; value: CreativeDirection }> = [
    {
      source: "format",
      value: legacyFormatCreativeDirection(input.jobDefaults, input.legacyPayload),
    },
    ...(input.template ? [{ source: "template" as const, value: input.template }] : []),
    ...(input.vertical ? [{ source: "vertical" as const, value: input.vertical }] : []),
    ...(input.brand ? [{ source: "brand" as const, value: input.brand }] : []),
    ...(input.user ? [{ source: "user" as const, value: input.user }] : []),
  ];
  for (const layer of layers) {
    const issues = validateCreativeDirection(layer.value);
    if (issues.length > 0) {
      throw new CreativeDirectionConflictError(
        `Invalid ${layer.source} creative direction: ${issues.join(", ")}`,
        issues,
      );
    }
  }

  const result: Record<string, any> = { version: 1 };
  const provenance = new Map<CreativeDirectionSourceKind, Set<string>>();
  const exclusiveOwners = new Map<string, CreativeDirectionSourceKind>();
  const clamps: ResolvedCreativeBrief["clamps"] = [];
  const note = (source: CreativeDirectionSourceKind, path: string) => {
    const fields = provenance.get(source) ?? new Set<string>();
    fields.add(path);
    provenance.set(source, fields);
  };
  const noteExclusive = (source: CreativeDirectionSourceKind, path: string) => {
    const previous = exclusiveOwners.get(path);
    if (previous && previous !== source) provenance.get(previous)?.delete(path);
    exclusiveOwners.set(path, source);
    note(source, path);
  };

  const merge = (
    target: Record<string, any>,
    sourceValue: Record<string, any>,
    source: CreativeDirectionSourceKind,
    prefix = "",
  ): void => {
    for (const [key, incoming] of Object.entries(sourceValue)) {
      if (key === "version" || incoming === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (path === "structure.sceneCount" && target[key]) {
        const min = Math.max(target[key].min, incoming.min);
        const max = Math.min(target[key].max, incoming.max);
        if (min > max) {
          clamps.push({ field: path, reason: "range did not overlap an earlier constraint", source });
        } else {
          target[key] = { min, max };
          note(source, path);
        }
      } else if (Array.isArray(incoming) && UNION_LIST_PATHS.has(path)) {
        const limit = UNION_LIST_PATHS.get(path)!;
        const combined = [...(Array.isArray(target[key]) ? target[key] : []), ...incoming];
        const seen = new Set<string>();
        target[key] = combined.filter((item) => {
          const itemKey = unionKey(item);
          if (seen.has(itemKey)) return false;
          seen.add(itemKey);
          return true;
        }).slice(0, limit);
        if (seen.size > limit) {
          clamps.push({ field: path, reason: `union capped at ${limit} items`, source });
        }
        note(source, path);
      } else if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
        if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
        merge(target[key], incoming, source, path);
      } else {
        target[key] = structuredClone(incoming);
        noteExclusive(source, path);
      }
    }
  };
  for (const layer of layers) merge(result, layer.value as unknown as Record<string, any>, layer.source);

  const narrative = result.narrative as Record<string, unknown> | undefined;
  const required = new Map<string, string>();
  for (const term of (narrative?.requiredVocabulary as string[] | undefined) ?? []) {
    required.set(normalizedTerm(term), term);
  }
  const conflicts = ((narrative?.forbiddenVocabulary as string[] | undefined) ?? [])
    .filter((term) => required.has(normalizedTerm(term)))
    .map((term) => required.get(normalizedTerm(term))!);
  if (conflicts.length > 0) {
    throw new CreativeDirectionConflictError(
      `Required and forbidden vocabulary conflict: ${conflicts.join(", ")}`,
      conflicts,
    );
  }

  const topic = input.topic?.trim();
  if (topic && topic.length > 1_000) {
    clamps.push({ field: "topic", reason: "topic capped at 1000 characters", source: "user" });
  }
  const entries: CreativeDirectionProvenanceEntry[] = layers
    .map(({ source }) => ({
      source,
      ...(input.references?.[source] ? { reference: input.references[source] } : {}),
      fields: [...(provenance.get(source) ?? [])].sort(),
    }))
    .filter((entry) => entry.fields.length > 0);
  return {
    version: 1,
    direction: result as CreativeDirection,
    ...(topic ? { topic: topic.slice(0, 1_000) } : {}),
    provenance: entries,
    clamps,
  };
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
