/**
 * Plan the b-roll beats that sit over a spokesperson take.
 *
 * The narration is already fixed — it is the presenter's own take, or a script
 * they are about to read — so nothing here writes copy. The job is deciding
 * what appears *above* that narration and when: which stretch of the script
 * each illustration covers, what to search for or generate, and where the
 * overlay should deliberately disappear.
 *
 * Two decisions shape the whole module.
 *
 * The model is asked for narration LINE RANGES, never for milliseconds. A
 * model handed timecodes will cheerfully return a beat from 6.4s to 13.1s that
 * cuts a sentence in half, and every such beat has to be repaired anyway.
 * Asking which lines a beat covers makes the timings fall out of the script
 * arithmetic instead, so they are correct by construction.
 *
 * Opacity is a lookup, not a model decision. How strongly an illustration sits
 * over a presenter follows from what kind of illustration it is — explanatory
 * graphics solid, footage of people translucent so the presenter still reads
 * through. A table does that consistently and for free. Models are for the
 * judgement calls, and this is not one.
 */

import type OpenAI from "openai";

import { parseModelJsonObject } from "../modelJson";

/** What an illustration *is*, which is what its opacity follows from. */
export const VISUAL_KINDS = ["graphic", "lifestyle", "product", "data"] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

/**
 * How solidly each kind sits over the presenter.
 *
 * Measured off reference videos in this format: anatomical and explanatory
 * graphics read as near-opaque panels, product and device shots stay solid so
 * the object is legible, and lifestyle footage is deliberately ghosted so the
 * presenter is never fully hidden behind a stranger's face.
 */
export const KIND_OPACITY: Readonly<Record<VisualKind, number>> = {
  graphic: 1.0,
  data: 0.95,
  product: 0.9,
  lifestyle: 0.55,
};

/** Below this a beat reads as a flicker rather than an illustration. */
export const MIN_BEAT_MS = 4000;
/** Above this the overlay goes stale and the eye stops tracking it. */
export const MAX_BEAT_MS = 12_000;
/** What a well-paced beat runs to; used only to guide the model. */
export const TARGET_BEAT_MS = 8000;

/** One timed line of the fixed narration. */
export interface NarrationLine {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface PlannedBeat {
  startMs: number;
  endMs: number;
  /**
   * English stock-footage search term, or a prompt for a generated graphic.
   *
   * English regardless of the narration's language, because Pexels and Pixabay
   * index English tags — the same constraint the topic-video script writer
   * already documents.
   */
  query: string;
  kind: VisualKind;
  /** Derived from `kind`; never taken from the model. */
  opacity: number;
  /** Narration lines this beat covers, for the review UI. */
  lineIndexes: number[];
}

export interface BeatPlanResult {
  beats: PlannedBeat[];
  /** Stretches the overlay deliberately leaves bare. */
  gaps: { startMs: number; endMs: number }[];
  /** What the repair pass had to change, in plain language, for the UI. */
  notes: string[];
  systemPrompt: string;
  rawResponse: string;
}

/* ------------------------------------------------------------------ *
 * The template
 * ------------------------------------------------------------------ */

/**
 * The prompt as governed blocks, ready to seed into `prompt_template_versions`
 * for flow key `video_broll_beats`.
 *
 * Exported in the prompt-kit block shape rather than as one string so the
 * first version can be inserted verbatim and then edited in the admin UI —
 * which is the point of the kit: changing how beats are chosen becomes a
 * content edit with review and rollback, not a deploy.
 */
export const BEAT_PLANNER_TEMPLATE_BLOCKS = [
  {
    id: "blk_broll_role",
    order: 1,
    title: "Role",
    mandatory: true,
    content:
      "You plan the illustrative footage that sits over a presenter in a short vertical video. " +
      "A person is on camera talking for the entire runtime and never cuts away. Your job is only " +
      "to decide what appears in the upper part of the frame above them, and over which part of " +
      "what they are saying. You do not write, rewrite, shorten or translate the narration.",
  },
  {
    id: "blk_broll_grouping",
    order: 2,
    title: "How to group",
    mandatory: true,
    content:
      "Group consecutive narration lines into beats. A beat must start at the beginning of a line " +
      `and end at the end of a line — never split one. Aim for about ${TARGET_BEAT_MS / 1000} ` +
      `seconds per beat; never plan one under ${MIN_BEAT_MS / 1000} seconds or over ` +
      `${MAX_BEAT_MS / 1000}. Each beat illustrates one idea. When the narration moves to a new ` +
      "idea, start a new beat, even if the previous one was short — merging two ideas under one " +
      "image is worse than a slightly uneven rhythm.",
  },
  {
    id: "blk_broll_bare_frame",
    order: 3,
    title: "Where to leave the frame bare",
    mandatory: true,
    content:
      "Leave the final line with no beat at all. The overlay disappearing is what makes a closing " +
      "instruction land — the viewer's attention returns to the person. Leave any other line bare " +
      "too when it is a direct address to the viewer rather than an explanation, and say so in the " +
      "reason. Do not illustrate every second of the script; bare stretches are a tool, not a gap " +
      "in your work.",
  },
  {
    id: "blk_broll_queries",
    order: 4,
    title: "What to ask for",
    mandatory: true,
    content:
      "Give each beat a query and a kind.\n" +
      "- graphic: a diagram, animation or explanatory illustration of a concept.\n" +
      "- data: a chart, counter or number the viewer should read.\n" +
      "- product: a physical object, device or package held or shown.\n" +
      "- lifestyle: real people doing an everyday thing.\n" +
      "Queries must be in English whatever language the narration is in, because the stock " +
      "libraries index English tags. Use one to four concrete words describing what is visible — " +
      '"woman walking outdoors", not "the importance of exercise". Never name a brand, a real ' +
      "person, or a copyrighted character.",
  },
  {
    id: "blk_broll_sequence",
    order: 5,
    title: "Sequence variety",
    mandatory: true,
    content:
      "Design the beats as an edit, not a list of near-duplicates. Consecutive beats must differ in " +
      "at least two of: visual kind, main subject, setting, shot scale, and composition. Never repeat " +
      "the same person/activity, location, or framing in adjacent beats. Across the whole plan, mix " +
      "explanatory graphics or data with product and lifestyle coverage whenever the narration supports " +
      "it. If two narration lines make a similar point, illustrate the later one through a different " +
      "visible consequence, object, or setting rather than paraphrasing the earlier query.",
  },
  {
    id: "blk_broll_output",
    order: 6,
    title: "Output",
    mandatory: true,
    content:
      'Reply with JSON only: {"beats":[{"firstLine":<number>,"lastLine":<number>,' +
      '"query":"<english search words>","kind":"graphic|data|product|lifestyle",' +
      '"reason":"<one short clause>"}]}\n' +
      "Line numbers refer to the numbered narration below. Beats must be in order and must not " +
      "overlap. Omit lines you are deliberately leaving bare rather than inventing a beat for them.",
  },
] as const;

export function buildBeatPlannerPrompt(
  blocks: readonly { order: number; title: string; content: string }[] = BEAT_PLANNER_TEMPLATE_BLOCKS,
): string {
  return [...blocks]
    .sort((a, b) => a.order - b.order)
    .map((block) => `${block.title.toUpperCase()}\n${block.content}`)
    .join("\n\n");
}

function buildUserPrompt(lines: readonly NarrationLine[]): string {
  const rows = lines.map((line) => {
    const seconds = ((line.endMs - line.startMs) / 1000).toFixed(1);
    return `${line.index}. [${seconds}s] ${line.text}`;
  });
  const totalSec = (Math.max(...lines.map((l) => l.endMs)) / 1000).toFixed(1);
  return (
    `Narration, ${totalSec}s total:\n\n${rows.join("\n")}` +
    "\n\nSequence rule: plan an intentionally varied visual sequence. Adjacent beats must not reuse " +
    "the same subject/activity, setting, or composition; change at least two of visual kind, subject, " +
    "setting, shot scale, and composition from one beat to the next. Keep the narration meaning fixed " +
    "but find a distinct visual angle when consecutive lines cover a similar idea."
  );
}

/* ------------------------------------------------------------------ *
 * Repair
 * ------------------------------------------------------------------ */

interface RawBeat {
  firstLine: number;
  lastLine: number;
  query: string;
  kind: VisualKind;
}

function parseBeats(raw: string): RawBeat[] {
  const parsed = parseModelJsonObject(raw) as { beats?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.beats)) return [];

  const out: RawBeat[] = [];
  for (const entry of parsed.beats) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const firstLine = Number(row.firstLine);
    const lastLine = Number(row.lastLine);
    const query = typeof row.query === "string" ? row.query.trim() : "";
    const kind = String(row.kind) as VisualKind;
    if (!Number.isInteger(firstLine) || !Number.isInteger(lastLine)) continue;
    if (lastLine < firstLine || query.length === 0) continue;
    out.push({
      firstLine,
      lastLine,
      query,
      kind: (VISUAL_KINDS as readonly string[]).includes(kind) ? kind : "lifestyle",
    });
  }
  return out.sort((a, b) => a.firstLine - b.firstLine);
}

/**
 * Turn the model's line ranges into timed beats and enforce the constraints.
 *
 * The model supplies intent; this decides what actually renders. Everything it
 * changes is recorded in `notes`, because a plan silently different from what
 * was asked for is the kind of thing nobody notices until the render.
 */
export function repairBeats(
  rawBeats: readonly RawBeat[],
  lines: readonly NarrationLine[],
): { beats: PlannedBeat[]; gaps: { startMs: number; endMs: number }[]; notes: string[] } {
  const notes: string[] = [];
  const byIndex = new Map(lines.map((line) => [line.index, line]));
  const lastLineIndex = Math.max(...lines.map((line) => line.index));

  const beats: PlannedBeat[] = [];
  let previousEndLine = -Infinity;

  for (const raw of rawBeats) {
    const first = byIndex.get(raw.firstLine);
    const last = byIndex.get(raw.lastLine);
    if (!first || !last) {
      notes.push(
        `Dropped a beat referring to lines ${raw.firstLine}–${raw.lastLine}, which do not exist.`,
      );
      continue;
    }

    // The closing line is always left bare: the overlay disappearing is what
    // makes the last instruction land.
    if (raw.lastLine >= lastLineIndex && raw.firstLine >= lastLineIndex) {
      notes.push("Dropped a beat over the closing line so it plays to camera.");
      continue;
    }
    const clippedLast = raw.lastLine >= lastLineIndex ? byIndex.get(lastLineIndex - 1) : last;
    if (!clippedLast || clippedLast.index < first.index) {
      notes.push("Dropped a beat that collapsed once the closing line was freed.");
      continue;
    }
    if (clippedLast.index !== last.index) {
      notes.push(`Beat ending on line ${last.index} pulled back to leave the closing line bare.`);
    }

    if (first.index <= previousEndLine) {
      notes.push(
        `Dropped a beat starting on line ${first.index}, which the previous beat already covered.`,
      );
      continue;
    }

    const startMs = first.startMs;
    const endMs = clippedLast.endMs;
    const durationMs = endMs - startMs;

    if (durationMs < MIN_BEAT_MS) {
      const previous = beats.at(-1);
      const mergedDurationMs = previous ? endMs - previous.startMs : Infinity;
      if (previous && previous.endMs === startMs && mergedDurationMs <= MAX_BEAT_MS) {
        // Too short to read on its own: fold it into the beat before it rather
        // than flashing an image for two seconds.
        previous.endMs = endMs;
        previous.lineIndexes = [
          ...previous.lineIndexes,
          ...lines
            .filter((l) => l.index >= first.index && l.index <= clippedLast.index)
            .map((l) => l.index),
        ];
        notes.push(`Merged a ${(durationMs / 1000).toFixed(1)}s beat into the one before it.`);
        previousEndLine = clippedLast.index;
        continue;
      }
      notes.push(
        previous
          ? `Kept a ${(durationMs / 1000).toFixed(1)}s beat separate because merging it would cross a gap or exceed the ${MAX_BEAT_MS / 1000}s ceiling.`
          : `Kept a ${(durationMs / 1000).toFixed(1)}s opening beat with nothing to merge into.`,
      );
    }

    const lineIndexes = lines
      .filter((l) => l.index >= first.index && l.index <= clippedLast.index)
      .map((l) => l.index);

    if (durationMs > MAX_BEAT_MS && lineIndexes.length > 1) {
      const splitWithinCeiling = (indexes: number[]): number[][] => {
        const groupStart = byIndex.get(indexes[0]!)!.startMs;
        const groupEnd = byIndex.get(indexes.at(-1)!)!.endMs;
        if (groupEnd - groupStart <= MAX_BEAT_MS) return [indexes];
        if (indexes.length === 1) return [];

        const midpoint = groupStart + (groupEnd - groupStart) / 2;
        let splitPosition = 1;
        let bestDelta = Infinity;
        for (let position = 1; position < indexes.length; position += 1) {
          const boundary = byIndex.get(indexes[position - 1]!)!.endMs;
          const delta = Math.abs(boundary - midpoint);
          if (delta < bestDelta) {
            bestDelta = delta;
            splitPosition = position;
          }
        }
        return [
          ...splitWithinCeiling(indexes.slice(0, splitPosition)),
          ...splitWithinCeiling(indexes.slice(splitPosition)),
        ];
      };

      const groups = splitWithinCeiling(lineIndexes);
      const kept = new Set(groups.flat());
      for (const indexes of groups) {
        beats.push({
          startMs: byIndex.get(indexes[0]!)!.startMs,
          endMs: byIndex.get(indexes.at(-1)!)!.endMs,
          query: raw.query,
          kind: raw.kind,
          opacity: KIND_OPACITY[raw.kind],
          lineIndexes: indexes,
        });
      }
      notes.push(
        `Split a ${(durationMs / 1000).toFixed(1)}s beat into ${groups.length} line-aligned beat${groups.length === 1 ? "" : "s"} — it was over the ${MAX_BEAT_MS / 1000}s ceiling.`,
      );
      const dropped = lineIndexes.filter((index) => !kept.has(index));
      if (dropped.length > 0) {
        notes.push(
          `Left ${dropped.length} overlong narration line${dropped.length === 1 ? "" : "s"} bare because line boundaries cannot be split.`,
        );
      }
      previousEndLine = clippedLast.index;
      continue;
    }

    if (durationMs > MAX_BEAT_MS) {
      notes.push(
        `Left an overlong ${(durationMs / 1000).toFixed(1)}s narration line bare because line boundaries cannot be split.`,
      );
      previousEndLine = clippedLast.index;
      continue;
    }

    beats.push({
      startMs,
      endMs,
      query: raw.query,
      kind: raw.kind,
      opacity: KIND_OPACITY[raw.kind],
      lineIndexes,
    });
    previousEndLine = clippedLast.index;
  }

  // Whatever the beats do not cover is a deliberate bare stretch.
  const totalEndMs = Math.max(...lines.map((line) => line.endMs));
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const beat of beats) {
    if (beat.startMs > cursor) gaps.push({ startMs: cursor, endMs: beat.startMs });
    cursor = beat.endMs;
  }
  if (cursor < totalEndMs) gaps.push({ startMs: cursor, endMs: totalEndMs });

  if (beats.length === 0) notes.push("No usable beats survived; the whole video plays bare.");

  return { beats, gaps, notes };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface PlanBeatsOptions {
  lines: readonly NarrationLine[];
  client: OpenAI;
  model: string;
  /** Governed template blocks; falls back to the built-in default. */
  templateBlocks?: readonly { order: number; title: string; content: string }[];
  requestParams?: Record<string, unknown>;
}

export async function planBeats(options: PlanBeatsOptions): Promise<BeatPlanResult> {
  if (options.lines.length === 0) {
    throw new Error("Cannot plan beats for an empty narration.");
  }

  const systemPrompt = buildBeatPlannerPrompt(options.templateBlocks);
  const completion = await options.client.chat.completions.create({
    model: options.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserPrompt(options.lines) },
    ],
    max_completion_tokens: 4096,
    response_format: { type: "json_object" },
    ...(options.requestParams ?? {}),
  });

  const rawResponse = completion.choices[0]?.message?.content ?? "{}";
  const { beats, gaps, notes } = repairBeats(parseBeats(rawResponse), options.lines);

  return { beats, gaps, notes, systemPrompt, rawResponse };
}