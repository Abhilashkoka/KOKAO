/**
 * Selections.
 *
 * A selection is an 8-bit coverage mask the size of the canvas: 0 is outside,
 * 255 is fully inside, and the values between are what make feathering mean
 * anything. Every tool — marquee, lasso, wand — produces one of these, so
 * "convert selection to layer mask", "fill selection", "delete selection" and
 * "generative fill inside the selection" are all the same operation applied to
 * the same array, rather than four tools with four representations.
 *
 * Written against plain typed arrays rather than a canvas so the geometry and
 * the flood fill can be tested. Rasterising an ellipse is exactly the kind of
 * code that is off by one pixel for a year if nothing ever checks it.
 */

export type SelectionMask = Uint8Array;

export type SelectionMode = "replace" | "add" | "subtract" | "intersect";

export interface RectSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createMask(width: number, height: number, fill = 0): SelectionMask {
  const mask = new Uint8Array(width * height);
  if (fill !== 0) mask.fill(fill);
  return mask;
}

export function isEmptyMask(mask: SelectionMask): boolean {
  for (let i = 0; i < mask.length; i += 1) if (mask[i] !== 0) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Rasterising shapes
 * ------------------------------------------------------------------ */

export function rasterizeRect(spec: RectSpec, width: number, height: number): SelectionMask {
  const mask = createMask(width, height);
  const x0 = Math.max(0, Math.floor(Math.min(spec.x, spec.x + spec.width)));
  const x1 = Math.min(width, Math.ceil(Math.max(spec.x, spec.x + spec.width)));
  const y0 = Math.max(0, Math.floor(Math.min(spec.y, spec.y + spec.height)));
  const y1 = Math.min(height, Math.ceil(Math.max(spec.y, spec.y + spec.height)));
  for (let y = y0; y < y1; y += 1) {
    mask.fill(255, y * width + x0, y * width + x1);
  }
  return mask;
}

/**
 * Ellipse inscribed in the given rect.
 *
 * Coverage is sampled at the pixel centre and softened by one pixel at the
 * boundary. A hard test produces visibly jagged marquees at small radii, and
 * since the mask is the thing that later clips a generative fill, those jaggies
 * end up baked into an image the user paid a credit for.
 */
export function rasterizeEllipse(spec: RectSpec, width: number, height: number): SelectionMask {
  const mask = createMask(width, height);
  const left = Math.min(spec.x, spec.x + spec.width);
  const top = Math.min(spec.y, spec.y + spec.height);
  const w = Math.abs(spec.width);
  const h = Math.abs(spec.height);
  if (w <= 0 || h <= 0) return mask;

  const cx = left + w / 2;
  const cy = top + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(width, Math.ceil(left + w));
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(height, Math.ceil(top + h));

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d <= 1) {
        // Feather the last pixel-width of the radius for a clean edge.
        const edge = 1 - Math.max(0, (d - (1 - 1 / Math.max(rx, ry))) * Math.max(rx, ry));
        mask[y * width + x] = Math.round(255 * Math.max(0, Math.min(1, edge)));
      }
    }
  }
  return mask;
}

/**
 * Even-odd scanline fill of a closed polygon.
 *
 * `points` is a flat [x0, y0, x1, y1, ...] list, matching the shape Konva's
 * Line takes, so the lasso can hand the same array to the renderer and to the
 * rasteriser without a conversion step that could disagree.
 */
export function rasterizePolygon(points: number[], width: number, height: number): SelectionMask {
  const mask = createMask(width, height);
  const count = Math.floor(points.length / 2);
  if (count < 3) return mask;

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < points.length; i += 2) {
    if (points[i] < minY) minY = points[i];
    if (points[i] > maxY) maxY = points[i];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));

  const crossings: number[] = [];
  for (let y = y0; y <= y1; y += 1) {
    crossings.length = 0;
    const sampleY = y + 0.5;
    for (let i = 0; i < count; i += 1) {
      const ax = points[i * 2];
      const ay = points[i * 2 + 1];
      const j = (i + 1) % count;
      const bx = points[j * 2];
      const by = points[j * 2 + 1];
      // Half-open test on y stops a vertex exactly on the scanline being
      // counted twice, which would punch a one-pixel hole in the fill.
      if (ay <= sampleY ? by > sampleY : by <= sampleY) {
        crossings.push(ax + ((sampleY - ay) / (by - ay)) * (bx - ax));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const sx = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const ex = Math.min(width - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let x = sx; x <= ex; x += 1) mask[y * width + x] = 255;
    }
  }
  return mask;
}

/* ------------------------------------------------------------------ *
 * Magic wand
 * ------------------------------------------------------------------ */

/**
 * Select pixels similar to the one clicked.
 *
 * `tolerance` is 0..255 measured as the largest per-channel difference,
 * including alpha — a cheaper metric than euclidean distance in RGB and, more
 * usefully here, one that treats "same colour, different transparency" as
 * different, so clicking the backdrop of a cut-out layer does not swallow the
 * subject's antialiased fringe.
 *
 * `contiguous` false is Photoshop's "global" wand: every matching pixel
 * anywhere, no flood fill.
 */
export function magicWand(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
  contiguous = true,
): SelectionMask {
  const mask = createMask(width, height);
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return mask;

  const seed = (sy * width + sx) * 4;
  const r0 = rgba[seed];
  const g0 = rgba[seed + 1];
  const b0 = rgba[seed + 2];
  const a0 = rgba[seed + 3];

  const matches = (index: number): boolean => {
    const i = index * 4;
    return (
      Math.abs(rgba[i] - r0) <= tolerance &&
      Math.abs(rgba[i + 1] - g0) <= tolerance &&
      Math.abs(rgba[i + 2] - b0) <= tolerance &&
      Math.abs(rgba[i + 3] - a0) <= tolerance
    );
  };

  if (!contiguous) {
    for (let i = 0; i < width * height; i += 1) if (matches(i)) mask[i] = 255;
    return mask;
  }

  // Scanline flood fill: walks a run left and right, then queues only the
  // pixels above and below where the run's membership changes. An explicit
  // stack, because a 1024² region recurses deep enough to blow the call stack.
  const stack: number[] = [sy * width + sx];
  while (stack.length > 0) {
    const start = stack.pop() as number;
    if (mask[start] !== 0 || !matches(start)) continue;

    const y = Math.floor(start / width);
    const rowStart = y * width;
    const rowEnd = rowStart + width;

    let left = start;
    while (left > rowStart && mask[left - 1] === 0 && matches(left - 1)) left -= 1;
    let right = start;
    while (right + 1 < rowEnd && mask[right + 1] === 0 && matches(right + 1)) right += 1;

    for (let i = left; i <= right; i += 1) {
      mask[i] = 255;
      const above = i - width;
      const below = i + width;
      if (above >= 0 && mask[above] === 0 && matches(above)) stack.push(above);
      if (below < mask.length && mask[below] === 0 && matches(below)) stack.push(below);
    }
  }

  return mask;
}

/* ------------------------------------------------------------------ *
 * Mask operations
 * ------------------------------------------------------------------ */

export function invertMask(mask: SelectionMask): SelectionMask {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) out[i] = 255 - mask[i];
  return out;
}

export function combineMasks(
  base: SelectionMask,
  incoming: SelectionMask,
  mode: SelectionMode,
): SelectionMask {
  if (mode === "replace") return incoming;
  const out = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i += 1) {
    switch (mode) {
      case "add":
        out[i] = Math.max(base[i], incoming[i]);
        break;
      case "subtract":
        out[i] = Math.max(0, base[i] - incoming[i]);
        break;
      case "intersect":
        out[i] = Math.min(base[i], incoming[i]);
        break;
    }
  }
  return out;
}

/**
 * Separable box blur, run three times.
 *
 * Three box passes approximate a gaussian closely enough that the difference
 * is invisible in a selection edge, and each pass is O(n) via a running sum
 * rather than O(n·r) — which matters because feathering happens live while the
 * user drags the radius slider over a million-pixel mask.
 */
export function featherMask(
  mask: SelectionMask,
  width: number,
  height: number,
  radius: number,
): SelectionMask {
  if (radius <= 0) return mask;
  const r = Math.min(Math.round(radius), Math.max(width, height));
  const current = new Uint8Array(mask);
  const scratch = new Uint8Array(mask.length);

  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurHorizontal(current, scratch, width, height, r);
    boxBlurVertical(scratch, current, width, height, r);
  }
  return current;
}

function boxBlurHorizontal(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let i = -radius; i <= radius; i += 1) {
      sum += src[row + Math.min(width - 1, Math.max(0, i))];
    }
    for (let x = 0; x < width; x += 1) {
      dst[row + x] = sum / window;
      const outIndex = row + Math.min(width - 1, Math.max(0, x - radius));
      const inIndex = row + Math.min(width - 1, Math.max(0, x + radius + 1));
      sum += src[inIndex] - src[outIndex];
    }
  }
}

function boxBlurVertical(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  radius: number,
): void {
  const window = radius * 2 + 1;
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let i = -radius; i <= radius; i += 1) {
      sum += src[Math.min(height - 1, Math.max(0, i)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / window;
      const outIndex = Math.min(height - 1, Math.max(0, y - radius)) * width + x;
      const inIndex = Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x;
      sum += src[inIndex] - src[outIndex];
    }
  }
}

/**
 * Dilate (positive) or erode (negative) a mask by `amount` pixels.
 *
 * Chebyshev distance via separable min/max passes: a square structuring
 * element rather than a disc. Cheaper, and at the radii people actually use
 * for "expand selection by 2px" the difference is not visible.
 */
export function resizeMask(
  mask: SelectionMask,
  width: number,
  height: number,
  amount: number,
): SelectionMask {
  const steps = Math.abs(Math.round(amount));
  if (steps === 0) return mask;
  const grow = amount > 0;
  let current = new Uint8Array(mask);
  const scratch = new Uint8Array(mask.length);

  for (let pass = 0; pass < steps; pass += 1) {
    // Horizontal
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const a = current[row + Math.max(0, x - 1)];
        const b = current[row + x];
        const c = current[row + Math.min(width - 1, x + 1)];
        scratch[row + x] = grow ? Math.max(a, b, c) : Math.min(a, b, c);
      }
    }
    // Vertical
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = scratch[Math.max(0, y - 1) * width + x];
        const b = scratch[y * width + x];
        const c = scratch[Math.min(height - 1, y + 1) * width + x];
        current[y * width + x] = grow ? Math.max(a, b, c) : Math.min(a, b, c);
      }
    }
  }
  return current;
}

/** Tight box around everything non-zero, or null when the mask is empty. */
export function maskBounds(
  mask: SelectionMask,
  width: number,
  height: number,
): RectSpec | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Expand a coverage mask into an RGBA buffer.
 *
 * `mode` "alpha" writes white with the coverage as alpha, which is what a
 * layer mask wants. "inpaint" writes opaque black everywhere the mask does NOT
 * cover and punches the covered region transparent, which is the convention
 * the image provider's edit endpoint expects — transparent means regenerate.
 * Getting these two backwards is the single easiest way to send a generative
 * fill that repaints everything except the thing the user selected.
 */
export function maskToRGBA(
  mask: SelectionMask,
  mode: "alpha" | "inpaint",
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i += 1) {
    const o = i * 4;
    if (mode === "alpha") {
      out[o] = 255;
      out[o + 1] = 255;
      out[o + 2] = 255;
      out[o + 3] = mask[i];
    } else {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255 - mask[i];
    }
  }
  return out;
}

/** Read a greyscale/alpha RGBA buffer back into a coverage mask. */
export function maskFromRGBA(rgba: Uint8ClampedArray, useAlpha = true): SelectionMask {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i += 1) {
    const o = i * 4;
    out[i] = useAlpha ? rgba[o + 3] : rgba[o];
  }
  return out;
}
