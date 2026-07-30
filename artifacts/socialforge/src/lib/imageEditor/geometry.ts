/**
 * Geometry: bounding boxes, snapping, alignment, distribution.
 *
 * Kept free of Konva on purpose. Konva can report a node's client rect, but
 * only for a node that is mounted and drawn, which means alignment could not
 * be computed for a collapsed group, could not be unit tested, and would
 * disagree with itself between the moment a layer is added and the first
 * redraw. Deriving boxes from the document instead makes all three problems
 * go away.
 */

import type { GroupLayer, Layer } from "./doc";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Untransformed size of a layer, before rotation, scale or skew. */
export function intrinsicSize(layer: Layer): { width: number; height: number } {
  switch (layer.type) {
    case "image":
    case "paint":
    case "shape":
    case "gradient":
      return { width: layer.width, height: layer.height };
    case "text": {
      // Text has no stored height; approximate from the font metrics the
      // renderer will use. Good enough for snapping and alignment, and the
      // canvas corrects it on the next transform-end.
      const lines = Math.max(1, layer.text.split("\n").length);
      const longest = layer.text
        .split("\n")
        .reduce((max, line) => Math.max(max, line.length), 0);
      const width = layer.width > 0 ? layer.width : longest * layer.fontSize * 0.55;
      return { width, height: lines * layer.fontSize * layer.lineHeight };
    }
    case "group": {
      const box = groupBounds(layer);
      return { width: box.width, height: box.height };
    }
    default:
      return { width: 0, height: 0 };
  }
}

function rotatePoint(p: Point, origin: Point, radians: number): Point {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/**
 * Axis-aligned bounding box of a layer after its full transform.
 *
 * Skew is applied before rotation, matching the order Konva composes its
 * matrix; getting that order wrong shows up as selection handles that drift
 * away from a skewed layer as it rotates.
 */
export function layerBounds(layer: Layer): Box {
  const { width, height } = intrinsicSize(layer);
  const w = width * layer.scaleX;
  const h = height * layer.scaleY;

  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((c) => ({
    x: c.x + c.y * layer.skewX,
    y: c.y + c.x * layer.skewY,
  }));

  const radians = (layer.rotation * Math.PI) / 180;
  const placed = corners
    .map((c) => rotatePoint(c, { x: 0, y: 0 }, radians))
    .map((c) => ({ x: c.x + layer.x, y: c.y + layer.y }));

  const xs = placed.map((p) => p.x);
  const ys = placed.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Union of a group's children, in the group's own coordinate space. */
export function groupBounds(group: GroupLayer): Box {
  if (group.children.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const boxes = group.children.map(layerBounds);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionBoxes(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* ------------------------------------------------------------------ *
 * Snapping
 * ------------------------------------------------------------------ */

export interface SnapGuide {
  axis: "x" | "y";
  /** Canvas coordinate the guide sits on. */
  position: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Snap a dragged box against the canvas and the other layers.
 *
 * Candidate lines are the three interesting positions on each axis — near
 * edge, centre, far edge — for the canvas and for every other layer's bounding
 * box. The dragged box offers the same three, and the smallest pairing inside
 * `threshold` wins per axis.
 *
 * `threshold` is in canvas pixels and the caller divides by zoom before
 * passing it in, so snapping feels the same distance on screen whether the
 * user is at 25% or 400%.
 */
export function computeSnap(
  moving: Box,
  others: Box[],
  canvas: { width: number; height: number },
  threshold: number,
): SnapResult {
  const linesX: number[] = [0, canvas.width / 2, canvas.width];
  const linesY: number[] = [0, canvas.height / 2, canvas.height];

  for (const box of others) {
    linesX.push(box.x, box.x + box.width / 2, box.x + box.width);
    linesY.push(box.y, box.y + box.height / 2, box.y + box.height);
  }

  const movingX = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const movingY = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  let bestX: { delta: number; line: number } | null = null;
  for (const line of linesX) {
    for (const edge of movingX) {
      const delta = line - edge;
      if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
        bestX = { delta, line };
      }
    }
  }

  let bestY: { delta: number; line: number } | null = null;
  for (const line of linesY) {
    for (const edge of movingY) {
      const delta = line - edge;
      if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
        bestY = { delta, line };
      }
    }
  }

  const guides: SnapGuide[] = [];
  if (bestX) guides.push({ axis: "x", position: bestX.line });
  if (bestY) guides.push({ axis: "y", position: bestY.line });

  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides };
}

/* ------------------------------------------------------------------ *
 * Align and distribute
 * ------------------------------------------------------------------ */

export type AlignMode = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";

/**
 * Offsets that align a set of boxes.
 *
 * Aligns to the union of the selection when more than one box is given, and to
 * the canvas when there is only one — which is what "align left" means in both
 * cases without the user having to think about which reference is active.
 */
export function alignOffsets(
  boxes: Box[],
  mode: AlignMode,
  canvas: { width: number; height: number },
): Array<{ dx: number; dy: number }> {
  if (boxes.length === 0) return [];
  const frame =
    boxes.length > 1 ? unionBoxes(boxes) : { x: 0, y: 0, width: canvas.width, height: canvas.height };

  return boxes.map((box) => {
    switch (mode) {
      case "left":
        return { dx: frame.x - box.x, dy: 0 };
      case "center-h":
        return { dx: frame.x + frame.width / 2 - (box.x + box.width / 2), dy: 0 };
      case "right":
        return { dx: frame.x + frame.width - (box.x + box.width), dy: 0 };
      case "top":
        return { dx: 0, dy: frame.y - box.y };
      case "center-v":
        return { dx: 0, dy: frame.y + frame.height / 2 - (box.y + box.height / 2) };
      case "bottom":
        return { dx: 0, dy: frame.y + frame.height - (box.y + box.height) };
      default:
        return { dx: 0, dy: 0 };
    }
  });
}

/**
 * Even spacing between three or more boxes along one axis.
 *
 * The outermost two stay put — they define the span the rest are spread
 * across. Fewer than three boxes has no interior to distribute, so it is a
 * no-op rather than an error.
 */
export function distributeOffsets(
  boxes: Box[],
  axis: "x" | "y",
): Array<{ dx: number; dy: number }> {
  const zero = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return zero;

  const indexed = boxes.map((box, index) => ({ box, index }));
  indexed.sort((a, b) => (axis === "x" ? a.box.x - b.box.x : a.box.y - b.box.y));

  const first = indexed[0].box;
  const last = indexed[indexed.length - 1].box;
  const size = (b: Box) => (axis === "x" ? b.width : b.height);
  const start = axis === "x" ? first.x : first.y;
  const end = (axis === "x" ? last.x : last.y) + size(last);

  const totalSize = indexed.reduce((sum, item) => sum + size(item.box), 0);
  const gap = (end - start - totalSize) / (indexed.length - 1);

  let cursor = start;
  const out = [...zero];
  for (const item of indexed) {
    const current = axis === "x" ? item.box.x : item.box.y;
    const delta = cursor - current;
    out[item.index] = axis === "x" ? { dx: delta, dy: 0 } : { dx: 0, dy: delta };
    cursor += size(item.box) + gap;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Viewport
 * ------------------------------------------------------------------ */

export const ZOOM_STEPS = [0.05, 0.1, 0.16, 0.25, 0.33, 0.5, 0.66, 1, 1.5, 2, 3, 4, 6, 8, 16];

export function nextZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  const below = ZOOM_STEPS.filter((z) => z < current - 0.001);
  return below.length > 0 ? below[below.length - 1] : ZOOM_STEPS[0];
}

/** Zoom that fits the canvas inside the viewport with a little breathing room. */
export function fitZoom(
  canvas: { width: number; height: number },
  viewport: { width: number; height: number },
  padding = 48,
): number {
  const available = {
    width: Math.max(1, viewport.width - padding * 2),
    height: Math.max(1, viewport.height - padding * 2),
  };
  return Math.max(0.02, Math.min(available.width / canvas.width, available.height / canvas.height, 8));
}

/** Keep the point under the cursor fixed while the zoom changes around it. */
export function zoomAboutPoint(
  offset: Point,
  oldZoom: number,
  newZoom: number,
  pointer: Point,
): Point {
  const worldX = (pointer.x - offset.x) / oldZoom;
  const worldY = (pointer.y - offset.y) / oldZoom;
  return { x: pointer.x - worldX * newZoom, y: pointer.y - worldY * newZoom };
}
