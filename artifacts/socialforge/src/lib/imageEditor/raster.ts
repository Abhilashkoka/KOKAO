/**
 * Live raster data: paint layers and layer masks.
 *
 * These are the only two things in the editor that are pixels rather than
 * description, and they are deliberately kept out of the document. A document
 * is JSON in a Postgres column that gets read on every library page load; a
 * 1024² mask inlined as base64 is ~100 KB of that JSON per layer.
 *
 * So the document holds a storage path and this store holds the canvas. The
 * contract between them is `dirty`: a canvas that has been painted since it
 * was loaded gets uploaded on save and its new path written back. A canvas
 * that has not is left alone, which means re-saving a post you only moved a
 * layer in does not re-upload every mask it has.
 *
 * Everything here touches the DOM, so it stays a thin mechanical layer with no
 * decisions in it — the decisions live in the pure modules next door.
 */

import type { SelectionMask } from "./selection";

export interface RasterEntry {
  canvas: HTMLCanvasElement;
  dirty: boolean;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export class RasterStore {
  private paint = new Map<string, RasterEntry>();
  private masks = new Map<string, RasterEntry>();
  /** Bumped on every mutation so React can re-render without deep comparison. */
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  private touch(): void {
    this.version += 1;
  }

  /* ---------------- paint layers ---------------- */

  paintCanvas(id: string, width: number, height: number): HTMLCanvasElement {
    const existing = this.paint.get(id);
    if (existing) return existing.canvas;
    const canvas = makeCanvas(width, height);
    this.paint.set(id, { canvas, dirty: false });
    this.touch();
    return canvas;
  }

  hasPaint(id: string): boolean {
    return this.paint.has(id);
  }

  markPaintDirty(id: string): void {
    const entry = this.paint.get(id);
    if (entry) {
      entry.dirty = true;
      this.touch();
    }
  }

  /* ---------------- masks ---------------- */

  /**
   * A layer's mask canvas, created white-filled on first request.
   *
   * White means "keep everything": adding a mask has to be a no-op until the
   * user paints on it, or every layer would vanish the moment it gained one.
   */
  maskCanvas(id: string, width: number, height: number): HTMLCanvasElement {
    const existing = this.masks.get(id);
    if (existing) return existing.canvas;
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    this.masks.set(id, { canvas, dirty: true });
    this.touch();
    return canvas;
  }

  hasMask(id: string): boolean {
    return this.masks.has(id);
  }

  markMaskDirty(id: string): void {
    const entry = this.masks.get(id);
    if (entry) {
      entry.dirty = true;
      this.touch();
    }
  }

  dropMask(id: string): void {
    if (this.masks.delete(id)) this.touch();
  }

  /** Write a coverage mask into a layer's mask canvas — "selection to mask". */
  setMaskFromSelection(
    id: string,
    selection: SelectionMask,
    width: number,
    height: number,
  ): void {
    const canvas = this.maskCanvas(id, width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(canvas.width, canvas.height);
    // Coverage lands in the ALPHA channel, not in RGB. The renderer composites
    // masks with `destination-in`, which reads alpha and ignores colour; a
    // greyscale-in-RGB mask would be fully opaque everywhere and hide nothing.
    for (let i = 0; i < selection.length && i * 4 < image.data.length; i += 1) {
      const o = i * 4;
      image.data[o] = 255;
      image.data[o + 1] = 255;
      image.data[o + 2] = 255;
      image.data[o + 3] = selection[i];
    }
    ctx.putImageData(image, 0, 0);
    this.markMaskDirty(id);
  }

  /* ---------------- loading from storage ---------------- */

  /**
   * Pull an already-saved raster back down so it can be painted on again.
   *
   * Marked clean on arrival: it matches what is in storage by definition, and
   * marking it dirty here would make every save re-upload every mask the user
   * merely looked at.
   */
  async load(kind: "paint" | "mask", id: string, url: string): Promise<void> {
    const image = await loadImage(url);
    const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    (kind === "paint" ? this.paint : this.masks).set(id, { canvas, dirty: false });
    this.touch();
  }

  /** Everything that needs uploading before the document can be saved. */
  dirtyEntries(): Array<{ kind: "paint" | "mask"; id: string; canvas: HTMLCanvasElement }> {
    const out: Array<{ kind: "paint" | "mask"; id: string; canvas: HTMLCanvasElement }> = [];
    for (const [id, entry] of this.paint) {
      if (entry.dirty) out.push({ kind: "paint", id, canvas: entry.canvas });
    }
    for (const [id, entry] of this.masks) {
      if (entry.dirty) out.push({ kind: "mask", id, canvas: entry.canvas });
    }
    return out;
  }

  markClean(kind: "paint" | "mask", id: string): void {
    const entry = (kind === "paint" ? this.paint : this.masks).get(id);
    if (entry) {
      entry.dirty = false;
      this.touch();
    }
  }

  getPaint(id: string): HTMLCanvasElement | null {
    return this.paint.get(id)?.canvas ?? null;
  }

  getMask(id: string): HTMLCanvasElement | null {
    return this.masks.get(id)?.canvas ?? null;
  }

  /**
   * Resize every canvas to a new document size, preserving content at its
   * current offset. Used by crop and canvas-resize, which must not silently
   * discard the parts of a mask that move outside the new frame if the user
   * then undoes.
   */
  resizeAll(width: number, height: number, offsetX: number, offsetY: number): void {
    const move = (map: Map<string, RasterEntry>, fillWhite: boolean) => {
      for (const [id, entry] of map) {
        const next = makeCanvas(width, height);
        const ctx = next.getContext("2d");
        if (ctx) {
          if (fillWhite) {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, next.width, next.height);
          }
          ctx.drawImage(entry.canvas, offsetX, offsetY);
        }
        map.set(id, { canvas: next, dirty: true });
      }
    };
    move(this.paint, false);
    move(this.masks, true);
    this.touch();
  }

  clear(): void {
    this.paint.clear();
    this.masks.clear();
    this.touch();
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image"));
    image.src = src;
  });
}

/** Canvas to raw PNG bytes, for the presigned upload. */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const dataUrl = canvas.toDataURL("image/png");
  const b64 = dataUrl.split(",")[1] ?? "";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function canvasToB64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

/** Storage URL for an object path, matching how the rest of the app reads objects. */
export function storageUrl(objectPath: string): string {
  return `/api/storage${objectPath}`;
}
