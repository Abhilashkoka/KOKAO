import sharp from "sharp";
import type { Tenant } from "@workspace/db";
import { uploadBufferToStorage } from "../storageUpload";
import { applyMadeWithWatermark } from "../watermark";
import { getPlan } from "../plans";
import { isFeatureEnabled } from "../featureFlags";
import type { UsageMeta } from "../usage";
import { meter, type MeterContext } from "../meter";
import { prepareCoverCanvas, typesetCover, type PreparedCanvas } from "./compose";
import { extractSubjectMatte } from "./matte";
import { COVER_HEIGHT, COVER_WIDTH, type CoverCopy, type CoverDocLayer, type CoverLayerDoc, type CoverLayout, type CoverOptions } from "./types";
export * from "./types";
export { draftCoverCopy, splitTopicIntoCopy } from "./copy";
export { EDITORIAL_VIDEO_FILTER } from "./grade";
export class CoverInputError extends Error {
  constructor(message: string) { super(message); this.name = "CoverInputError"; }
}
class CoverMatteUnavailable extends Error {}
export interface CoverOutcome {
  imagePath: string; b64Json: string; basePath: string; subjectPath: string | null;
  layout: CoverLayout; notice: string | null; layerDoc: CoverLayerDoc;
  matteMeta: Omit<UsageMeta, "funding"> | null;
}
async function assertReusable(base: Buffer, subject: Buffer | null): Promise<void> {
  const b = await sharp(base).metadata();
  if (b.width !== COVER_WIDTH || b.height !== COVER_HEIGHT) {
    throw new CoverInputError("That base image is not a cover canvas. Start from the photo instead.");
  }
  if (subject) {
    const s = await sharp(subject).metadata();
    if (s.width !== COVER_WIDTH || s.height !== COVER_HEIGHT || !s.hasAlpha) {
      throw new CoverInputError("That subject layer does not belong to this cover. Start from the photo instead.");
    }
  }
}
export async function buildCover(input: {
  tenantId: number; tenant: Tenant; copy: CoverCopy; options: CoverOptions; source?: Buffer;
  meterContext?: MeterContext | null;
  reuse?: { base: Buffer; basePath: string; subject: Buffer | null; subjectPath: string | null };
}): Promise<CoverOutcome> {
  if (!input.copy.headline) throw new CoverInputError("Add a headline for the cover.");
  let canvas: PreparedCanvas;
  let basePath: string | null = null, subjectPath: string | null = null;
  let matteMeta: CoverOutcome["matteMeta"] = null;
  if (input.reuse) {
    await assertReusable(input.reuse.base, input.reuse.subject);
    canvas = { base: input.reuse.base, subject: input.reuse.subject };
    basePath = input.reuse.basePath;
    subjectPath = input.reuse.subject ? input.reuse.subjectPath : null;
  } else if (input.source) {
    let matte: Awaited<ReturnType<typeof extractSubjectMatte>> = null;
    if (input.options.layout === "behind") {
      try {
        matte = await meter(input.meterContext ?? null, "image_edit", 1, async () => {
          const result = await extractSubjectMatte(input.source!);
          if (!result) throw new CoverMatteUnavailable();
          return result;
        });
      } catch (error) {
        if (!(error instanceof CoverMatteUnavailable)) throw error;
      }
    }
    matteMeta = matte?.meta ?? null;
    canvas = await prepareCoverCanvas({ source: input.source, matte: matte?.matte ?? null, options: input.options });
  } else { throw new CoverInputError("Choose a photo for the cover."); }
  const set = await typesetCover({ canvas, copy: input.copy, options: input.options });
  const wantWatermark = (await getPlan(input.tenant.plan).catch(() => null))?.watermark === true &&
    (await isFeatureEnabled("freeWatermark").catch(() => true));
  const flat = wantWatermark ? await applyMadeWithWatermark(set.flat) : set.flat;
  const editorBaseIsCanvas = set.base === canvas.base;
  const typeBlocks = set.blocks.filter((b) => b.id !== "subject");
  const [uploadedBase, uploadedEditorBase, uploadedSubject, flatPath, ...blockPaths] = await Promise.all([
    basePath ? Promise.resolve(basePath) : uploadBufferToStorage(input.tenantId, canvas.base, "image/png"),
    editorBaseIsCanvas ? Promise.resolve(null) : uploadBufferToStorage(input.tenantId, set.base, "image/png"),
    canvas.subject && !subjectPath ? uploadBufferToStorage(input.tenantId, canvas.subject, "image/png") : Promise.resolve(subjectPath),
    uploadBufferToStorage(input.tenantId, flat, "image/png"),
    ...typeBlocks.map((b) => uploadBufferToStorage(input.tenantId, b.buffer, "image/png")),
  ]);
  const pathFor = new Map(typeBlocks.map((b, i) => [b, blockPaths[i]!]));
  const layers: CoverDocLayer[] = [];
  for (const b of set.blocks) {
    const objectPath = b.id === "subject" ? uploadedSubject : pathFor.get(b);
    if (!objectPath) continue;
    layers.push({
      id: `cover_${b.id}`, type: "image", objectPath, x: b.x, y: b.y, width: b.width, height: b.height,
      rotation: 0, scaleX: 1, scaleY: 1, name: b.name,
    });
  }
  return {
    imagePath: flatPath, b64Json: flat.toString("base64"), basePath: uploadedBase, subjectPath: uploadedSubject ?? null,
    layout: set.layout, notice: set.notice, layerDoc: { version: 1, basePath: uploadedEditorBase ?? uploadedBase, layers }, matteMeta,
  };
}