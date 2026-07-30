/**
 * The layered image document, version 2.
 *
 * v1 (shipped with the Konva editor) was a flat list of text and image layers
 * over an implicit base image. It could express "put a logo here" and nothing
 * else. v2 keeps that vocabulary and adds the things a compositor needs:
 * groups, masks, clipping, non-destructive adjustments, layer effects, the
 * full canvas blend-mode set, and an explicit canvas size so crop and
 * canvas-resize have somewhere to live.
 *
 * Two rules govern every change in here:
 *
 *  1. A v1 document must open, render identically, and lose nothing. Users
 *     have saved posts in the old shape; `migrateDoc` is the only door and it
 *     is total — it never throws, never drops a layer it recognises.
 *  2. The document is persisted as opaque JSON in `content_items.image_layers`
 *     and round-trips through the API untyped. So nothing in here may assume
 *     it was written by code of the same version: `normalizeDoc` treats every
 *     field as hostile and coerces rather than rejects, because a document
 *     that fails to parse is a post the user can no longer edit.
 *
 * Raster data (paint strokes, layer masks) is NOT inlined. It lives in object
 * storage and the document holds the path. A 1024² mask as a base64 PNG is
 * ~100 KB of JSON per layer; ten of those in a jsonb column is a post that
 * takes a second to load. The editor keeps live canvases in memory and uploads
 * the dirty ones on save.
 */

/* ------------------------------------------------------------------ *
 * Blend modes
 * ------------------------------------------------------------------ */

/**
 * The blend modes this editor supports: every mode the 2D canvas implements,
 * and only those.
 *
 * Photoshop has eight more (dissolve, linear-burn, vivid-light, linear-light,
 * pin-light, hard-mix, subtract, divide) that the canvas has no operator for.
 * Supporting them means reading the backdrop back out of the layer canvas and
 * blending in JavaScript on every redraw — a per-frame `getImageData` over the
 * whole document, reached through a Konva internal, for eight modes that are
 * rare in the work this editor is for.
 *
 * The alternative — listing them and mapping each to its nearest neighbour —
 * is worse than not listing them: the preview and the export would agree with
 * each other and disagree with the name on the menu, and the user only finds
 * out after they have published. So the list is short and every entry is
 * exact. A document that arrives with one of the missing modes normalises to
 * `normal` rather than to a lookalike.
 */
export const BLEND_MODES = [
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "linear-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/** Blend mode to its `globalCompositeOperation` value. Total by construction. */
export const NATIVE_BLEND: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  darken: "darken",
  multiply: "multiply",
  "color-burn": "color-burn",
  lighten: "lighten",
  screen: "screen",
  "color-dodge": "color-dodge",
  "linear-dodge": "lighter",
  overlay: "overlay",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export function isBlendMode(v: unknown): v is BlendMode {
  return typeof v === "string" && (BLEND_MODES as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ *
 * Adjustments
 * ------------------------------------------------------------------ */

/**
 * Non-destructive per-layer colour and tone controls.
 *
 * Every field is optional and every absent field means "identity". That is
 * what makes these cheap: a layer with no adjustments carries no adjustment
 * keys at all, so an untouched v1 document does not grow when it round-trips
 * through v2, and the render path can skip the whole filter pipeline with one
 * `hasAdjustments` check instead of comparing a dozen numbers to their
 * defaults.
 */
export interface Adjustments {
  /** -1..1, added to every channel. */
  brightness?: number;
  /** -100..100, S-curve around mid grey. */
  contrast?: number;
  /** -2..10, Konva HSL saturation units. 0 is untouched. */
  saturation?: number;
  /** -180..180 degrees. */
  hue?: number;
  /** -2..2, HSL lightness. */
  luminance?: number;
  /** Gaussian blur radius in canvas pixels. */
  blur?: number;
  /** 0..1, unsharp-mask strength. */
  sharpen?: number;
  /** 0..1, monochrome grain. */
  noise?: number;
  /** Block size in pixels; 0/absent is off. */
  pixelate?: number;
  /** 2..255 levels per channel. */
  posterize?: number;
  /** 0..1 luminance cutoff. */
  threshold?: number;
  grayscale?: boolean;
  sepia?: boolean;
  invert?: boolean;
  /** Per-channel multipliers, 0..2, for split toning. */
  channels?: { r: number; g: number; b: number };
}

const ADJUSTMENT_RANGES: Record<string, [number, number]> = {
  brightness: [-1, 1],
  contrast: [-100, 100],
  saturation: [-2, 10],
  hue: [-180, 180],
  luminance: [-2, 2],
  blur: [0, 200],
  sharpen: [0, 1],
  noise: [0, 1],
  pixelate: [0, 128],
  posterize: [2, 255],
  threshold: [0, 1],
};

/** True when anything in here would change a pixel. */
export function hasAdjustments(a: Adjustments | undefined): boolean {
  if (!a) return false;
  return Object.keys(a).length > 0;
}

/* ------------------------------------------------------------------ *
 * Layer effects
 * ------------------------------------------------------------------ */

export interface ShadowFx {
  color: string;
  /** 0..1 */
  opacity: number;
  /** Degrees, 0 = light from the right, matching Photoshop's dial. */
  angle: number;
  distance: number;
  blur: number;
  spread: number;
}

export interface StrokeFx {
  color: string;
  width: number;
  position: "outside" | "inside" | "center";
  opacity: number;
}

export interface GlowFx {
  color: string;
  blur: number;
  spread: number;
  opacity: number;
}

export interface OverlayFx {
  color: string;
  opacity: number;
  blend: BlendMode;
}

export interface GradientOverlayFx {
  from: string;
  to: string;
  angle: number;
  opacity: number;
}

/**
 * Layer styles. Each is present-or-absent rather than
 * present-with-an-enabled-flag: toggling an effect off in the UI deletes the
 * key, so a document never carries the settings of an effect nobody can see,
 * and `hasFx` stays a cheap key count.
 */
export interface LayerFx {
  dropShadow?: ShadowFx;
  stroke?: StrokeFx;
  outerGlow?: GlowFx;
  colorOverlay?: OverlayFx;
  gradientOverlay?: GradientOverlayFx;
}

export function hasFx(fx: LayerFx | undefined): boolean {
  return !!fx && Object.keys(fx).length > 0;
}

export const DEFAULT_SHADOW: ShadowFx = {
  color: "#000000",
  opacity: 0.5,
  angle: 120,
  distance: 8,
  blur: 12,
  spread: 0,
};

export const DEFAULT_STROKE: StrokeFx = {
  color: "#ffffff",
  width: 3,
  position: "outside",
  opacity: 1,
};

export const DEFAULT_GLOW: GlowFx = {
  color: "#ffd6e7",
  blur: 16,
  spread: 0,
  opacity: 0.75,
};

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

export type LayerType = "image" | "text" | "shape" | "gradient" | "paint" | "adjustment" | "group";

export type ShapeKind = "rect" | "ellipse" | "line" | "triangle" | "star" | "polygon";

/** Fields every layer has, whatever it draws. */
export interface BaseLayer {
  id: string;
  type: LayerType;
  name: string;
  visible: boolean;
  /** Locked layers cannot be selected on canvas, moved, or edited. */
  locked: boolean;
  /** 0..1, applied to the layer including its effects. */
  opacity: number;
  /** 0..1, applied to the layer's own pixels but NOT its effects — the
   * distinction Photoshop draws between Opacity and Fill, and the reason a
   * knockout-text-with-a-stroke look is possible at all. */
  fill: number;
  blend: BlendMode;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  /** Clip to the composite of the layers below it inside the same parent —
   * Photoshop's clipping mask (alt-click between layers). */
  clipped: boolean;
  /** Object-storage path of a greyscale PNG mask. White keeps, black hides. */
  maskPath?: string;
  /** Mask temporarily switched off without being discarded. */
  maskDisabled?: boolean;
  adjustments?: Adjustments;
  fx?: LayerFx;
}

export interface ImageLayer extends BaseLayer {
  type: "image";
  objectPath: string;
  width: number;
  height: number;
}

export interface PaintLayer extends BaseLayer {
  type: "paint";
  /** Uploaded on save; empty while the strokes only exist on the live canvas. */
  objectPath: string;
  width: number;
  height: number;
}

export interface TextLayer extends BaseLayer {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: string;
  fontStyle: string;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  /** Fixed width for wrapping; 0 means the text sizes to its content. */
  width: number;
  underline: boolean;
  uppercase: boolean;
}

export interface ShapeLayer extends BaseLayer {
  type: "shape";
  shape: ShapeKind;
  width: number;
  height: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  cornerRadius: number;
  /** Points for star/polygon. */
  sides: number;
}

export interface GradientLayer extends BaseLayer {
  type: "gradient";
  width: number;
  height: number;
  from: string;
  to: string;
  angle: number;
  kind: "linear" | "radial";
}

/**
 * An adjustment layer: contributes no pixels of its own, and instead applies
 * its `adjustments` to everything composited below it within its parent.
 *
 * Modelled as a layer rather than a document-level list because that is what
 * makes it stackable and maskable — the whole point of the feature is that you
 * can put a curve over half an image by masking the adjustment, not the art.
 */
export interface AdjustmentLayer extends BaseLayer {
  type: "adjustment";
}

export interface GroupLayer extends BaseLayer {
  type: "group";
  children: Layer[];
  /** Collapsed groups render normally; this is purely a panel affordance. */
  collapsed: boolean;
  /** Isolate blending: children blend with each other but the group composites
   * as a unit. Off matches "pass through", Photoshop's group default. */
  isolate: boolean;
}

export type Layer =
  | ImageLayer
  | PaintLayer
  | TextLayer
  | ShapeLayer
  | GradientLayer
  | AdjustmentLayer
  | GroupLayer;

export interface ImageDoc {
  version: 2;
  /** Canvas size in pixels. Crop and canvas-resize write here. */
  width: number;
  height: number;
  /**
   * The original source image the document was authored against. Kept at the
   * top level even though the background is also a normal layer, because the
   * AI operations need "the image this document is about" as a single path and
   * walking the tree to guess would break the moment someone deletes the
   * background.
   */
  basePath: string;
  layers: Layer[];
}

/** Id of the synthesised background layer. Stable so migration is idempotent. */
export const BASE_LAYER_ID = "__base";

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

let idCounter = 0;

export function newLayerId(prefix = "l"): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** Shared defaults, so every layer factory below stays a one-liner over this. */
export function baseLayerDefaults(type: LayerType, name: string): BaseLayer {
  return {
    id: newLayerId(),
    type,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    fill: 1,
    blend: "normal",
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    skewY: 0,
    clipped: false,
  };
}

export function makeImageLayer(objectPath: string, width: number, height: number, name = "Image"): ImageLayer {
  return { ...baseLayerDefaults("image", name), type: "image", objectPath, width, height };
}

export function makePaintLayer(width: number, height: number, name = "Paint"): PaintLayer {
  return { ...baseLayerDefaults("paint", name), type: "paint", objectPath: "", width, height };
}

export function makeTextLayer(text: string, fontSize: number): TextLayer {
  return {
    ...baseLayerDefaults("text", text.slice(0, 24) || "Text"),
    type: "text",
    text,
    fontSize,
    fontFamily: "Inter, system-ui, sans-serif",
    fontStyle: "normal",
    fontWeight: 700,
    color: "#ffffff",
    align: "left",
    lineHeight: 1.2,
    letterSpacing: 0,
    width: 0,
    underline: false,
    uppercase: false,
  };
}

export function makeShapeLayer(shape: ShapeKind, width: number, height: number): ShapeLayer {
  return {
    ...baseLayerDefaults("shape", shape[0].toUpperCase() + shape.slice(1)),
    type: "shape",
    shape,
    width,
    height,
    color: "#f5d0e0",
    strokeColor: "#00000000",
    strokeWidth: 0,
    cornerRadius: shape === "rect" ? 8 : 0,
    sides: shape === "star" ? 5 : 6,
  };
}

export function makeGradientLayer(width: number, height: number): GradientLayer {
  return {
    ...baseLayerDefaults("gradient", "Gradient"),
    type: "gradient",
    width,
    height,
    from: "#ffd6e7",
    to: "#c9e4f5",
    angle: 90,
    kind: "linear",
  };
}

export function makeAdjustmentLayer(adjustments: Adjustments, name = "Adjustment"): AdjustmentLayer {
  return { ...baseLayerDefaults("adjustment", name), type: "adjustment", adjustments };
}

export function makeGroupLayer(children: Layer[] = [], name = "Group"): GroupLayer {
  return { ...baseLayerDefaults("group", name), type: "group", children, collapsed: false, isolate: false };
}

/* ------------------------------------------------------------------ *
 * Coercion
 * ------------------------------------------------------------------ */

function num(v: unknown, fallback: number, min?: number, max?: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function colour(v: unknown, fallback: string): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback;
}

function normalizeAdjustments(raw: unknown): Adjustments | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Adjustments = {};
  for (const [key, [min, max]] of Object.entries(ADJUSTMENT_RANGES)) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const clamped = Math.min(max, Math.max(min, v));
      // Drop identity values so an all-defaults adjustment object collapses to
      // undefined and the render path can skip the filter chain entirely.
      if (clamped !== 0 || key === "posterize") (out as Record<string, unknown>)[key] = clamped;
    }
  }
  for (const key of ["grayscale", "sepia", "invert"] as const) {
    if (r[key] === true) out[key] = true;
  }
  const ch = r.channels;
  if (ch && typeof ch === "object") {
    const c = ch as Record<string, unknown>;
    const rr = num(c.r, 1, 0, 2);
    const gg = num(c.g, 1, 0, 2);
    const bb = num(c.b, 1, 0, 2);
    if (rr !== 1 || gg !== 1 || bb !== 1) out.channels = { r: rr, g: gg, b: bb };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeShadowFx(raw: unknown): ShadowFx | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    color: colour(r.color, DEFAULT_SHADOW.color),
    opacity: num(r.opacity, DEFAULT_SHADOW.opacity, 0, 1),
    angle: num(r.angle, DEFAULT_SHADOW.angle, -360, 360),
    distance: num(r.distance, DEFAULT_SHADOW.distance, 0, 500),
    blur: num(r.blur, DEFAULT_SHADOW.blur, 0, 300),
    spread: num(r.spread, DEFAULT_SHADOW.spread, 0, 100),
  };
}

function normalizeGlowFx(raw: unknown): GlowFx | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    color: colour(r.color, DEFAULT_GLOW.color),
    blur: num(r.blur, DEFAULT_GLOW.blur, 0, 300),
    spread: num(r.spread, DEFAULT_GLOW.spread, 0, 100),
    opacity: num(r.opacity, DEFAULT_GLOW.opacity, 0, 1),
  };
}

function normalizeFx(raw: unknown): LayerFx | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: LayerFx = {};
  const drop = normalizeShadowFx(r.dropShadow);
  if (drop) out.dropShadow = drop;
  const outerGlow = normalizeGlowFx(r.outerGlow);
  if (outerGlow) out.outerGlow = outerGlow;
  if (r.stroke && typeof r.stroke === "object") {
    const s = r.stroke as Record<string, unknown>;
    const position = s.position;
    out.stroke = {
      color: colour(s.color, DEFAULT_STROKE.color),
      width: num(s.width, DEFAULT_STROKE.width, 0, 200),
      position:
        position === "inside" || position === "center" ? position : "outside",
      opacity: num(s.opacity, DEFAULT_STROKE.opacity, 0, 1),
    };
  }
  if (r.colorOverlay && typeof r.colorOverlay === "object") {
    const o = r.colorOverlay as Record<string, unknown>;
    out.colorOverlay = {
      color: colour(o.color, "#000000"),
      opacity: num(o.opacity, 1, 0, 1),
      blend: isBlendMode(o.blend) ? o.blend : "normal",
    };
  }
  if (r.gradientOverlay && typeof r.gradientOverlay === "object") {
    const o = r.gradientOverlay as Record<string, unknown>;
    out.gradientOverlay = {
      from: colour(o.from, "#ffd6e7"),
      to: colour(o.to, "#c9e4f5"),
      angle: num(o.angle, 90, -360, 360),
      opacity: num(o.opacity, 1, 0, 1),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeBase(raw: Record<string, unknown>, type: LayerType, fallbackName: string): BaseLayer {
  const out: BaseLayer = {
    id: str(raw.id, "") || newLayerId(),
    type,
    name: str(raw.name, fallbackName).slice(0, 80) || fallbackName,
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
    opacity: num(raw.opacity, 1, 0, 1),
    fill: num(raw.fill, 1, 0, 1),
    blend: isBlendMode(raw.blend) ? raw.blend : "normal",
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    rotation: num(raw.rotation, 0, -3600, 3600),
    scaleX: num(raw.scaleX, 1, -100, 100),
    scaleY: num(raw.scaleY, 1, -100, 100),
    skewX: num(raw.skewX, 0, -10, 10),
    skewY: num(raw.skewY, 0, -10, 10),
    clipped: bool(raw.clipped, false),
  };
  const maskPath = str(raw.maskPath, "");
  if (maskPath) out.maskPath = maskPath;
  if (raw.maskDisabled === true) out.maskDisabled = true;
  const adjustments = normalizeAdjustments(raw.adjustments);
  if (adjustments) out.adjustments = adjustments;
  const fx = normalizeFx(raw.fx);
  if (fx) out.fx = fx;
  return out;
}

/** Guard against a hand-crafted document nesting groups until the renderer blows the stack. */
const MAX_GROUP_DEPTH = 12;

function normalizeLayer(raw: unknown, depth: number): Layer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;

  if (type === "group") {
    if (depth >= MAX_GROUP_DEPTH) return null;
    const children = Array.isArray(r.children)
      ? r.children.map((c) => normalizeLayer(c, depth + 1)).filter((l): l is Layer => l !== null)
      : [];
    return {
      ...normalizeBase(r, "group", "Group"),
      type: "group",
      children,
      collapsed: bool(r.collapsed, false),
      isolate: bool(r.isolate, false),
    };
  }

  if (type === "text") {
    const align = r.align;
    return {
      ...normalizeBase(r, "text", "Text"),
      type: "text",
      text: str(r.text, ""),
      fontSize: num(r.fontSize, 48, 1, 4000),
      fontFamily: str(r.fontFamily, "Inter, system-ui, sans-serif"),
      fontStyle: str(r.fontStyle, "normal"),
      fontWeight: num(r.fontWeight, 400, 100, 900),
      // v1 called this `fill` and meant a colour; v2's `fill` is an opacity, so
      // the colour moved to `color`. Read the old key when the new one is
      // absent or a v1 text layer would silently turn black.
      color: colour(r.color ?? r.fill, "#ffffff"),
      align: align === "center" || align === "right" ? align : "left",
      lineHeight: num(r.lineHeight, 1.2, 0.5, 5),
      letterSpacing: num(r.letterSpacing, 0, -50, 200),
      width: num(r.width, 0, 0, 20000),
      underline: bool(r.underline, false),
      uppercase: bool(r.uppercase, false),
    };
  }

  if (type === "shape") {
    const shape = r.shape;
    const kinds: ShapeKind[] = ["rect", "ellipse", "line", "triangle", "star", "polygon"];
    return {
      ...normalizeBase(r, "shape", "Shape"),
      type: "shape",
      shape: kinds.includes(shape as ShapeKind) ? (shape as ShapeKind) : "rect",
      width: num(r.width, 200, 1, 20000),
      height: num(r.height, 200, 1, 20000),
      color: colour(r.color, "#f5d0e0"),
      strokeColor: colour(r.strokeColor, "#00000000"),
      strokeWidth: num(r.strokeWidth, 0, 0, 200),
      cornerRadius: num(r.cornerRadius, 0, 0, 2000),
      sides: num(r.sides, 6, 3, 24),
    };
  }

  if (type === "gradient") {
    return {
      ...normalizeBase(r, "gradient", "Gradient"),
      type: "gradient",
      width: num(r.width, 512, 1, 20000),
      height: num(r.height, 512, 1, 20000),
      from: colour(r.from, "#ffd6e7"),
      to: colour(r.to, "#c9e4f5"),
      angle: num(r.angle, 90, -360, 360),
      kind: r.kind === "radial" ? "radial" : "linear",
    };
  }

  if (type === "adjustment") {
    return { ...normalizeBase(r, "adjustment", "Adjustment"), type: "adjustment" };
  }

  if (type === "paint") {
    return {
      ...normalizeBase(r, "paint", "Paint"),
      type: "paint",
      objectPath: str(r.objectPath, ""),
      width: num(r.width, 512, 1, 20000),
      height: num(r.height, 512, 1, 20000),
    };
  }

  if (type === "image") {
    const objectPath = str(r.objectPath, "");
    if (!objectPath) return null;
    return {
      ...normalizeBase(r, "image", "Image"),
      type: "image",
      objectPath,
      width: num(r.width, 512, 1, 20000),
      height: num(r.height, 512, 1, 20000),
    };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * v1 migration
 * ------------------------------------------------------------------ */

interface V1Layer {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  fontSize?: unknown;
  fill?: unknown;
  fontFamily?: unknown;
  fontStyle?: unknown;
  rotation?: unknown;
  scaleX?: unknown;
  scaleY?: unknown;
  objectPath?: unknown;
  width?: unknown;
  height?: unknown;
  opacity?: unknown;
  blend?: unknown;
  name?: unknown;
}

/**
 * Lift a v1 layer into v2.
 *
 * The only lossy-looking part is v1's `blend: "normal" | "multiply"`, which is
 * a strict subset of v2's set, so it is not lossy at all. Everything else is
 * a field-for-field copy plus v2 defaults.
 */
function migrateV1Layer(raw: V1Layer): Layer | null {
  if (raw.type === "text") {
    return normalizeLayer(
      {
        ...raw,
        type: "text",
        color: typeof raw.fill === "string" ? raw.fill : "#ffffff",
        fill: 1,
        fontWeight: raw.fontStyle === "bold" ? 700 : 400,
      },
      1,
    );
  }
  if (raw.type === "image") {
    return normalizeLayer(
      {
        ...raw,
        type: "image",
        fill: 1,
        opacity: typeof raw.opacity === "number" ? raw.opacity : 1,
        name: typeof raw.name === "string" ? raw.name : "Element",
      },
      1,
    );
  }
  return null;
}

/**
 * Turn anything stored in `content_items.image_layers` into a v2 document.
 *
 * `fallbackBase` is the image path the caller is editing, used when the stored
 * document has no base of its own (a fresh image, or a v1 doc written before
 * basePath was recorded). `width`/`height` come from the loaded bitmap, since
 * v1 never stored a canvas size.
 */
export function migrateDoc(
  raw: unknown,
  fallbackBase: string,
  width: number,
  height: number,
): ImageDoc {
  const empty = (): ImageDoc => ({
    version: 2,
    width,
    height,
    basePath: fallbackBase,
    layers: [
      {
        ...baseLayerDefaults("image", "Background"),
        id: BASE_LAYER_ID,
        type: "image",
        objectPath: fallbackBase,
        width,
        height,
      } as ImageLayer,
    ],
  });

  if (!raw || typeof raw !== "object") return empty();
  const d = raw as Record<string, unknown>;

  if (d.version === 2) {
    const layers = Array.isArray(d.layers)
      ? d.layers.map((l) => normalizeLayer(l, 0)).filter((l): l is Layer => l !== null)
      : [];
    const basePath = str(d.basePath, fallbackBase) || fallbackBase;
    const doc: ImageDoc = {
      version: 2,
      width: num(d.width, width, 1, 20000),
      height: num(d.height, height, 1, 20000),
      basePath,
      layers,
    };
    // A document whose background was deleted is legal — the user may have cut
    // it out on purpose — but a document with NO layers at all is a blank
    // screen the user cannot recover from, so re-seed the base.
    if (doc.layers.length === 0) return empty();
    return doc;
  }

  if (d.version === 1 && Array.isArray(d.layers)) {
    const basePath = str(d.basePath, fallbackBase) || fallbackBase;
    const migrated = (d.layers as V1Layer[])
      .map(migrateV1Layer)
      .filter((l): l is Layer => l !== null);
    return {
      version: 2,
      width,
      height,
      basePath,
      layers: [
        {
          ...baseLayerDefaults("image", "Background"),
          id: BASE_LAYER_ID,
          type: "image",
          objectPath: basePath,
          width,
          height,
        } as ImageLayer,
        ...migrated,
      ],
    };
  }

  return empty();
}

/** Coerce a v2 document that has already been through migration. */
export function normalizeDoc(raw: unknown, fallbackBase: string, width: number, height: number): ImageDoc {
  return migrateDoc(raw, fallbackBase, width, height);
}

/* ------------------------------------------------------------------ *
 * Tree helpers
 *
 * Layers nest, so every operation the UI needs — select, move, reorder,
 * delete, group — is a tree walk. These are pure and total: an id that is not
 * in the tree is a no-op, never a throw, because the panel and the canvas can
 * briefly disagree about what exists during a drag.
 * ------------------------------------------------------------------ */

/** Depth-first, parents before children, in paint order (bottom of the stack first). */
export function walkLayers(layers: Layer[], visit: (layer: Layer, parent: GroupLayer | null, depth: number) => void): void {
  const rec = (list: Layer[], parent: GroupLayer | null, depth: number) => {
    for (const layer of list) {
      visit(layer, parent, depth);
      if (layer.type === "group") rec(layer.children, layer, depth + 1);
    }
  };
  rec(layers, null, 0);
}

export function findLayer(layers: Layer[], id: string): Layer | null {
  let found: Layer | null = null;
  walkLayers(layers, (l) => {
    if (l.id === id) found = l;
  });
  return found;
}

export function findParent(layers: Layer[], id: string): GroupLayer | null {
  let found: GroupLayer | null = null;
  walkLayers(layers, (l, parent) => {
    if (l.id === id) found = parent;
  });
  return found;
}

/** Every layer in the tree, flattened, with its depth — what the panel renders. */
export function flattenLayers(layers: Layer[]): Array<{ layer: Layer; depth: number; parentId: string | null }> {
  const out: Array<{ layer: Layer; depth: number; parentId: string | null }> = [];
  walkLayers(layers, (layer, parent, depth) => {
    out.push({ layer, depth, parentId: parent?.id ?? null });
  });
  return out;
}

/** Replace one layer by id, returning a new tree. Untouched branches keep their identity. */
export function mapLayer(layers: Layer[], id: string, fn: (layer: Layer) => Layer): Layer[] {
  let changed = false;
  const rec = (list: Layer[]): Layer[] => {
    const next = list.map((layer) => {
      if (layer.id === id) {
        changed = true;
        return fn(layer);
      }
      if (layer.type === "group") {
        const children = rec(layer.children);
        if (children !== layer.children) return { ...layer, children };
      }
      return layer;
    });
    return changed ? next : list;
  };
  return rec(layers);
}

/**
 * All three structural operations below return the SAME array when they change
 * nothing.
 *
 * That is not a micro-optimisation: the canvas re-caches a layer whenever its
 * props change identity, and re-caching means re-rendering a document-sized
 * offscreen canvas per affected layer. A delete that misses, or a nudge that
 * runs off the end of the stack, must not cost a full redraw.
 */
export function removeLayer(layers: Layer[], id: string): Layer[] {
  const rec = (list: Layer[]): Layer[] => {
    const filtered = list.filter((l) => l.id !== id);
    let changed = filtered.length !== list.length;
    const next = filtered.map((layer) => {
      if (layer.type !== "group") return layer;
      const children = rec(layer.children);
      if (children === layer.children) return layer;
      changed = true;
      return { ...layer, children };
    });
    return changed ? next : list;
  };
  return rec(layers);
}

/** Insert `layer` directly above `siblingId`, or at the top when it is null. */
export function insertLayer(layers: Layer[], layer: Layer, siblingId: string | null): Layer[] {
  if (!siblingId) return [...layers, layer];
  let inserted = false;
  const rec = (list: Layer[]): Layer[] => {
    const out: Layer[] = [];
    for (const item of list) {
      const next = item.type === "group" ? { ...item, children: rec(item.children) } : item;
      out.push(next);
      if (item.id === siblingId) {
        out.push(layer);
        inserted = true;
      }
    }
    return out;
  };
  const result = rec(layers);
  return inserted ? result : [...layers, layer];
}

/**
 * Move a layer one step up or down within its own parent.
 *
 * Deliberately does NOT hop between parents: a reorder that silently pulled a
 * layer out of the group it was clipped to would change what the image looks
 * like, and the user asked to nudge it, not to restructure. Dragging in the
 * panel is the way to change parents.
 */
export function reorderLayer(layers: Layer[], id: string, direction: 1 | -1): Layer[] {
  const rec = (list: Layer[]): Layer[] => {
    const idx = list.findIndex((l) => l.id === id);
    if (idx !== -1) {
      const to = idx + direction;
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      return next;
    }
    let changed = false;
    const next = list.map((layer) => {
      if (layer.type !== "group") return layer;
      const children = rec(layer.children);
      if (children === layer.children) return layer;
      changed = true;
      return { ...layer, children };
    });
    return changed ? next : list;
  };
  return rec(layers);
}

/**
 * Wrap the given ids in a new group, placed where the topmost of them sat.
 *
 * Only ids that share a parent are grouped — grouping across parents would
 * have to pick one branch to win, and any choice moves art the user did not
 * ask to move.
 */
export function groupLayers(layers: Layer[], ids: string[]): { layers: Layer[]; groupId: string | null } {
  if (ids.length === 0) return { layers, groupId: null };
  const idSet = new Set(ids);
  let groupId: string | null = null;

  const recurseOnly = (list: Layer[]): Layer[] =>
    list.map((layer) =>
      layer.type === "group" ? { ...layer, children: recurseOnly(layer.children) } : layer,
    );

  const rec = (list: Layer[]): Layer[] => {
    // Only the first sibling list containing any of the ids is grouped. Ids
    // spread across parents would otherwise produce several groups from one
    // action, which is never what "group these" means.
    if (groupId) return recurseOnly(list);

    const matching = list.filter((l) => idSet.has(l.id));
    if (matching.length > 0) {
      const group = makeGroupLayer(matching, "Group");
      groupId = group.id;
      const topIndex = Math.max(...matching.map((m) => list.indexOf(m)));
      const kept = list.filter((l) => !idSet.has(l.id));
      // The group takes the position of the topmost layer it swallowed, so the
      // stack looks the same afterwards as it did before.
      const insertAt = list.slice(0, topIndex + 1).filter((l) => !idSet.has(l.id)).length;
      const out = [...kept];
      out.splice(insertAt, 0, group);
      return out;
    }

    return list.map((layer) =>
      layer.type === "group" ? { ...layer, children: rec(layer.children) } : layer,
    );
  };

  return { layers: rec(layers), groupId };
}

/** Dissolve a group, splicing its children into the group's place. */
export function ungroupLayer(layers: Layer[], id: string): Layer[] {
  const rec = (list: Layer[]): Layer[] => {
    let changed = false;
    const out: Layer[] = [];
    for (const item of list) {
      if (item.id === id && item.type === "group") {
        out.push(...item.children);
        changed = true;
        continue;
      }
      if (item.type === "group") {
        const children = rec(item.children);
        if (children !== item.children) {
          changed = true;
          out.push({ ...item, children });
          continue;
        }
      }
      out.push(item);
    }
    return changed ? out : list;
  };
  return rec(layers);
}

/** Deep copy with fresh ids, so a duplicated group does not alias its children. */
export function cloneLayer(layer: Layer): Layer {
  const copy: Layer = { ...layer, id: newLayerId() };
  if (copy.type === "group" && layer.type === "group") {
    copy.children = layer.children.map(cloneLayer);
  }
  return copy;
}

/** Human-readable label for the layers panel. */
export function layerLabel(layer: Layer): string {
  if (layer.name) return layer.name;
  if (layer.type === "text") return layer.text.slice(0, 24) || "Text";
  return layer.type[0].toUpperCase() + layer.type.slice(1);
}
