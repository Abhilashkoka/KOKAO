import type { ImageSize } from "../imageGen";

/**
 * Shared vocabulary for layered image generation.
 *
 * The output type is deliberately NOT a new one: a layered generation emits
 * exactly the `{ version: 1, basePath, layers }` document that
 * content_items.image_layers already stores and the Konva editor already
 * opens. Inventing a second layer format would have meant a second editor.
 *
 * The INPUT type (LayerPlan) is new, because nothing in the codebase yet
 * describes "an image as a stack of things still to be rendered".
 */

/** Hard ceiling on layers per plan. Past this, edge and lighting drift between
 * independent renders costs more than the extra separation buys — and each
 * layer is a billed generation, so the cap is a spend guard too. */
export const MAX_PLANNED_LAYERS = 8;

/** Floor: below this there is nothing to separate and the user should just
 * generate a flat image for one credit. */
export const MIN_PLANNED_LAYERS = 2;

export type LayerRole = "background" | "object" | "shadow";

export interface PlannedLayer {
  /** Stable slug, unique within the plan. Becomes the editor layer id. */
  id: string;
  role: LayerRole;
  /** Paint order, ascending. The background is always the lowest. */
  z: number;
  /** [x1, y1, x2, y2] in canvas pixels. Ignored for the background. */
  bbox: [number, number, number, number];
  /** What this element is, on its own, with no scene around it. */
  prompt: string;
}

export interface LayerPlan {
  /**
   * Subject-agnostic look: medium, lens, light direction and quality, colour
   * temperature, palette, grain. Copied verbatim into every layer prompt —
   * this string is the only thing keeping independently rendered layers from
   * looking like a collage.
   */
  styleDna: string;
  layers: PlannedLayer[];
}

/** Canvas pixel dimensions for a supported output size. */
export function canvasFor(size: ImageSize): { width: number; height: number } {
  const [w, h] = size.split("x").map(Number);
  return { width: w || 1024, height: h || 1024 };
}

/**
 * How many billable image generations a plan costs: one call per layer. The
 * quote endpoint and the funding reservation both go through this so the
 * number the user agreed to is the number they are charged.
 */
export function planUnits(plan: LayerPlan): number {
  return plan.layers.length;
}

function slug(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.toLowerCase().replace(/[^a-z0-9]+/g, "_") : "";
  const trimmed = s.replace(/^_+|_+$/g, "").slice(0, 40);
  return trimmed || fallback;
}

function clampBox(
  raw: unknown,
  width: number,
  height: number,
): [number, number, number, number] {
  const full: [number, number, number, number] = [0, 0, width, height];
  if (!Array.isArray(raw) || raw.length !== 4) return full;
  const nums = raw.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : NaN));
  if (nums.some(Number.isNaN)) return full;
  const x1 = Math.max(0, Math.min(width, Math.round(Math.min(nums[0], nums[2]))));
  const y1 = Math.max(0, Math.min(height, Math.round(Math.min(nums[1], nums[3]))));
  const x2 = Math.max(0, Math.min(width, Math.round(Math.max(nums[0], nums[2]))));
  const y2 = Math.max(0, Math.min(height, Math.round(Math.max(nums[1], nums[3]))));
  // A degenerate box would render a zero-pixel layer, which reads to the user
  // as "the model ignored me" rather than "the box was bad". Fall back to full
  // canvas and let them move it.
  if (x2 - x1 < 16 || y2 - y1 < 16) return full;
  return [x1, y1, x2, y2];
}

/**
 * Coerce anything plan-shaped into a plan we are willing to bill for.
 *
 * Applied to BOTH the model's own output and a plan posted back by the client
 * after a quote — the client one especially, because a hand-edited plan is an
 * attacker-controlled way to ask for fifty generations. Returns null when the
 * input cannot be salvaged into something worth charging for.
 */
export function normalizeLayerPlan(raw: unknown, size: ImageSize): LayerPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const { width, height } = canvasFor(size);
  const obj = raw as { styleDna?: unknown; layers?: unknown };

  const styleDna = typeof obj.styleDna === "string" ? obj.styleDna.trim().slice(0, 600) : "";
  if (!Array.isArray(obj.layers)) return null;

  const seen = new Set<string>();
  const layers: PlannedLayer[] = [];
  for (const entry of obj.layers) {
    if (!entry || typeof entry !== "object") continue;
    const l = entry as Record<string, unknown>;
    const prompt = typeof l.prompt === "string" ? l.prompt.trim().slice(0, 600) : "";
    if (!prompt) continue;
    const role: LayerRole =
      l.role === "background" || l.role === "shadow" ? l.role : "object";
    let id = slug(l.id, `layer_${layers.length + 1}`);
    while (seen.has(id)) id = `${id}_${layers.length + 1}`;
    seen.add(id);
    layers.push({
      id,
      role,
      z: typeof l.z === "number" && Number.isFinite(l.z) ? l.z : (layers.length + 1) * 10,
      bbox: role === "background" ? [0, 0, width, height] : clampBox(l.bbox, width, height),
      prompt,
    });
    if (layers.length >= MAX_PLANNED_LAYERS) break;
  }

  // Exactly one background, always at the bottom. Anything else and the
  // composite has either a hole or a covered-up first render we still paid for.
  const backgrounds = layers.filter((l) => l.role === "background");
  if (backgrounds.length === 0) return null;
  for (const extra of backgrounds.slice(1)) extra.role = "object";
  backgrounds[0].z = Number.NEGATIVE_INFINITY;

  layers.sort((a, b) => a.z - b.z);
  layers.forEach((l, i) => {
    l.z = i * 10;
  });

  if (layers.length < MIN_PLANNED_LAYERS) return null;
  return { styleDna, layers };
}
