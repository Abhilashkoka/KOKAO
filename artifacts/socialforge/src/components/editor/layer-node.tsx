/**
 * Rendering one layer.
 *
 * Konva gives you nodes and a compositing operation per node; everything else
 * a compositor needs — masks, clipping, non-destructive filters, layer styles
 * — has to be built out of caching and canvas composite operations. The rules
 * this file encodes:
 *
 *  - A layer is cached (rendered to its own offscreen canvas) only when it has
 *    to be: a mask, an adjustment, or an overlay effect. Caching is what makes
 *    those isolate correctly, and it is also the expensive thing, so an
 *    ordinary untouched layer skips it entirely and draws straight through.
 *  - Masks are canvas-aligned and composite with `destination-in`, which reads
 *    the mask canvas's ALPHA. That is why `RasterStore` keeps masks as
 *    white-with-variable-alpha rather than greyscale.
 *  - Clipping masks are `source-atop` inside a cached group holding the base
 *    layer and everything clipped to it, which is exactly the semantics
 *    Photoshop's alt-click gives you.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import {
  Ellipse,
  Group,
  Image as KonvaImage,
  Line,
  Rect,
  RegularPolygon,
  Star,
  Text as KonvaText,
} from "react-konva";
import Konva from "konva";
import { Factory } from "konva/lib/Factory";
import type { Filter, FilterFunction } from "konva/lib/Node";
import useImage from "use-image";
import type { FilterStep } from "@/lib/imageEditor/adjustments";
import { applyChannels, applySharpen, buildFilterPlan } from "@/lib/imageEditor/adjustments";
import { compositeOperationFor } from "@/lib/imageEditor/blend";
import { hasFx, type ImageDoc, type Layer } from "@/lib/imageEditor/doc";
import { storageUrl, type RasterStore } from "@/lib/imageEditor/raster";

/* ------------------------------------------------------------------ *
 * Custom filters
 * ------------------------------------------------------------------ */

let filtersRegistered = false;

/**
 * Konva reads a filter's parameters off node attributes, so a custom filter
 * needs its attributes declared on Konva.Node before any node can carry them.
 * Registration is global and idempotent — calling it per component mount is
 * cheap and avoids an import-order dependency on module side effects.
 */
export function registerEditorFilters(): void {
  if (filtersRegistered) return;
  filtersRegistered = true;
  // Konva types `addGetterSetter`'s attribute name as a key of the class it is
  // extending, which by definition a NEW attribute is not. The cast is the
  // documented way to add one.
  const addAttr = Factory.addGetterSetter as unknown as (
    klass: unknown,
    attr: string,
    def?: unknown,
  ) => void;
  addAttr(Konva.Node, "sharpenAmount", 0);
  addAttr(Konva.Node, "channelR", 1);
  addAttr(Konva.Node, "channelG", 1);
  addAttr(Konva.Node, "channelB", 1);
}

type AttrReader = Record<string, () => number>;

const SharpenFilter: FilterFunction = function (imageData) {
  const amount = (this as unknown as AttrReader).sharpenAmount?.() ?? 0;
  applySharpen(imageData.data, imageData.width, imageData.height, amount);
};

const ChannelsFilter: FilterFunction = function (imageData) {
  const node = this as unknown as AttrReader;
  applyChannels(
    imageData.data,
    node.channelR?.() ?? 1,
    node.channelG?.() ?? 1,
    node.channelB?.() ?? 1,
  );
};

// Konva types its built-ins as `Filter`, which is `FilterFunction | string`;
// the custom ones below are plain functions and widen into it cleanly.
const KONVA_FILTERS: Record<FilterStep["filter"], Filter> = {
  Blur: Konva.Filters.Blur,
  Brighten: Konva.Filters.Brighten,
  Contrast: Konva.Filters.Contrast,
  Grayscale: Konva.Filters.Grayscale,
  HSL: Konva.Filters.HSL,
  Invert: Konva.Filters.Invert,
  Noise: Konva.Filters.Noise,
  Pixelate: Konva.Filters.Pixelate,
  Posterize: Konva.Filters.Posterize,
  Sepia: Konva.Filters.Sepia,
  Threshold: Konva.Filters.Threshold,
  Sharpen: SharpenFilter,
  Channels: ChannelsFilter,
};

/* ------------------------------------------------------------------ *
 * Caching
 * ------------------------------------------------------------------ */

interface CacheBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Apply a filter plan to a node and (re)cache it.
 *
 * The cache box is the whole document rather than the node's own bounds so
 * that a canvas-aligned mask lines up with the layer it masks no matter where
 * the layer has been dragged to. `signature` exists because Konva's cache is
 * imperative state on a mutable node: without an explicit dependency string,
 * React reconciles the props, Konva keeps the stale bitmap, and the user sees
 * a slider do nothing until they nudge the layer.
 */
function useCachedFilters(
  ref: React.MutableRefObject<Konva.Group | null>,
  plan: FilterStep[],
  box: CacheBox,
  active: boolean,
  signature: string,
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!active) {
      node.filters([]);
      node.clearCache();
      node.getLayer()?.batchDraw();
      return;
    }
    for (const step of plan) {
      for (const [attr, value] of Object.entries(step.attrs)) node.setAttr(attr, value);
    }
    node.filters(plan.map((step) => KONVA_FILTERS[step.filter]));
    node.cache({ ...box, imageSmoothingEnabled: true });
    node.getLayer()?.batchDraw();
    // `signature` folds every input that should invalidate the bitmap into one
    // string; listing them individually here would silently miss new ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, active]);
}

/* ------------------------------------------------------------------ *
 * Layer content
 * ------------------------------------------------------------------ */

function shadowProps(layer: Layer) {
  const shadow = layer.fx?.dropShadow;
  const glow = layer.fx?.outerGlow;
  // Konva gives a node one shadow. A glow is a shadow with no offset, so when
  // a layer asks for both, the drop shadow wins and the glow is dropped rather
  // than quietly blended into something that is neither.
  const source = shadow ?? glow;
  if (!source) return {};
  const angle = shadow ? ((shadow.angle - 90) * Math.PI) / 180 : 0;
  const distance = shadow ? shadow.distance : 0;
  return {
    shadowColor: source.color,
    shadowBlur: source.blur,
    shadowOpacity: source.opacity,
    shadowOffsetX: Math.cos(angle) * distance,
    shadowOffsetY: Math.sin(angle) * distance,
  };
}

function ImageContent({
  layer,
  src,
  onReady,
}: {
  layer: Layer & { width: number; height: number };
  src: string;
  onReady?: () => void;
}) {
  const [image] = useImage(src, "anonymous");
  useLayoutEffect(() => {
    if (image && onReady) onReady();
  }, [image, onReady]);
  return (
    <KonvaImage
      image={image}
      width={layer.width}
      height={layer.height}
      listening={false}
      {...shadowProps(layer)}
    />
  );
}

function CanvasContent({
  canvas,
  layer,
}: {
  canvas: HTMLCanvasElement | null;
  layer: Layer & { width: number; height: number };
}) {
  if (!canvas) return null;
  return (
    <KonvaImage
      image={canvas}
      width={layer.width}
      height={layer.height}
      listening={false}
      {...shadowProps(layer)}
    />
  );
}

function LayerContent({
  layer,
  raster,
  onImageReady,
}: {
  layer: Layer;
  raster: RasterStore;
  onImageReady: () => void;
}) {
  switch (layer.type) {
    case "image":
      return <ImageContent layer={layer} src={storageUrl(layer.objectPath)} onReady={onImageReady} />;

    case "paint":
      return <CanvasContent canvas={raster.getPaint(layer.id)} layer={layer} />;

    case "text": {
      const stroke = layer.fx?.stroke;
      return (
        <KonvaText
          text={layer.uppercase ? layer.text.toUpperCase() : layer.text}
          fontSize={layer.fontSize}
          fontFamily={layer.fontFamily}
          fontStyle={`${layer.fontStyle === "italic" ? "italic " : ""}${layer.fontWeight >= 600 ? "bold" : "normal"}`}
          fill={layer.color}
          align={layer.align}
          width={layer.width > 0 ? layer.width : undefined}
          lineHeight={layer.lineHeight}
          letterSpacing={layer.letterSpacing}
          textDecoration={layer.underline ? "underline" : ""}
          listening={false}
          stroke={stroke ? stroke.color : undefined}
          strokeWidth={stroke ? stroke.width : 0}
          // An outside stroke on text has to paint under the glyph or it eats
          // the letterforms at any width above a hairline.
          fillAfterStrokeEnabled={stroke?.position !== "inside"}
          {...shadowProps(layer)}
        />
      );
    }

    case "shape": {
      const stroke = layer.fx?.stroke;
      const common = {
        fill: layer.color,
        stroke: stroke ? stroke.color : layer.strokeColor,
        strokeWidth: stroke ? stroke.width : layer.strokeWidth,
        listening: false,
        ...shadowProps(layer),
      };
      if (layer.shape === "ellipse") {
        return (
          <Ellipse
            radiusX={layer.width / 2}
            radiusY={layer.height / 2}
            x={layer.width / 2}
            y={layer.height / 2}
            {...common}
          />
        );
      }
      if (layer.shape === "line") {
        return <Line points={[0, 0, layer.width, 0]} {...common} strokeWidth={Math.max(1, layer.strokeWidth || 4)} />;
      }
      if (layer.shape === "triangle") {
        return (
          <RegularPolygon
            sides={3}
            radius={Math.min(layer.width, layer.height) / 2}
            x={layer.width / 2}
            y={layer.height / 2}
            {...common}
          />
        );
      }
      if (layer.shape === "star") {
        return (
          <Star
            numPoints={layer.sides}
            innerRadius={Math.min(layer.width, layer.height) / 4}
            outerRadius={Math.min(layer.width, layer.height) / 2}
            x={layer.width / 2}
            y={layer.height / 2}
            {...common}
          />
        );
      }
      if (layer.shape === "polygon") {
        return (
          <RegularPolygon
            sides={layer.sides}
            radius={Math.min(layer.width, layer.height) / 2}
            x={layer.width / 2}
            y={layer.height / 2}
            {...common}
          />
        );
      }
      return <Rect width={layer.width} height={layer.height} cornerRadius={layer.cornerRadius} {...common} />;
    }

    case "gradient": {
      const radians = (layer.angle * Math.PI) / 180;
      const end = {
        x: Math.cos(radians) * layer.width,
        y: Math.sin(radians) * layer.height,
      };
      if (layer.kind === "radial") {
        return (
          <Rect
            width={layer.width}
            height={layer.height}
            fillRadialGradientStartPoint={{ x: layer.width / 2, y: layer.height / 2 }}
            fillRadialGradientEndPoint={{ x: layer.width / 2, y: layer.height / 2 }}
            fillRadialGradientStartRadius={0}
            fillRadialGradientEndRadius={Math.max(layer.width, layer.height) / 2}
            fillRadialGradientColorStops={[0, layer.from, 1, layer.to]}
            listening={false}
          />
        );
      }
      return (
        <Rect
          width={layer.width}
          height={layer.height}
          fillLinearGradientStartPoint={{ x: 0, y: 0 }}
          fillLinearGradientEndPoint={end}
          fillLinearGradientColorStops={[0, layer.from, 1, layer.to]}
          listening={false}
        />
      );
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * The layer itself
 * ------------------------------------------------------------------ */

export interface LayerNodeProps {
  layer: Layer;
  doc: ImageDoc;
  raster: RasterStore;
  rasterVersion: number;
  /** Bumped by the canvas when an image finishes decoding, to force a re-cache. */
  onContentReady: () => void;
  children?: React.ReactNode;
}

/** Layer size, for effects that need to cover the layer exactly. */
function layerExtent(layer: Layer, doc: ImageDoc): { width: number; height: number } {
  if ("width" in layer && "height" in layer && typeof layer.width === "number") {
    return { width: layer.width || doc.width, height: layer.height || doc.height };
  }
  return { width: doc.width, height: doc.height };
}

export function LayerNode({
  layer,
  doc,
  raster,
  rasterVersion,
  onContentReady,
  children,
}: LayerNodeProps) {
  registerEditorFilters();
  const groupRef = useRef<Konva.Group | null>(null);

  const plan = useMemo(() => buildFilterPlan(layer.adjustments), [layer.adjustments]);
  const maskCanvas = layer.maskDisabled ? null : raster.getMask(layer.id);
  const overlay = layer.fx?.colorOverlay;
  const gradientOverlay = layer.fx?.gradientOverlay;
  const extent = layerExtent(layer, doc);

  // Anything that composites against the layer's own pixels — a mask, a filter,
  // an overlay — needs the layer isolated on its own canvas first, or it would
  // composite against everything already drawn underneath.
  const needsCache = plan.length > 0 || !!maskCanvas || !!overlay || !!gradientOverlay;

  const signature = [
    layer.id,
    JSON.stringify(layer.adjustments ?? {}),
    maskCanvas ? `mask${rasterVersion}` : "nomask",
    JSON.stringify(layer.fx ?? {}),
    extent.width,
    extent.height,
    doc.width,
    doc.height,
    layer.visible,
    "text" in layer ? String((layer as { text?: string }).text) : "",
  ].join("|");

  useCachedFilters(
    groupRef,
    plan,
    { x: 0, y: 0, width: doc.width, height: doc.height },
    needsCache,
    signature,
  );

  if (!layer.visible) return null;

  const content = (
    <>
      <Group
        x={layer.x}
        y={layer.y}
        rotation={layer.rotation}
        scaleX={layer.scaleX}
        scaleY={layer.scaleY}
        skewX={layer.skewX}
        skewY={layer.skewY}
        // Fill is opacity applied to the layer's own pixels but not its
        // effects, which is what makes "invisible fill, visible stroke" work.
        opacity={layer.fill}
        listening={false}
      >
        <LayerContent layer={layer} raster={raster} onImageReady={onContentReady} />
        {children}
      </Group>

      {overlay && (
        <Rect
          x={layer.x}
          y={layer.y}
          width={extent.width}
          height={extent.height}
          fill={overlay.color}
          opacity={overlay.opacity}
          globalCompositeOperation={
            // source-atop keeps the overlay inside the layer's own alpha, so a
            // cut-out subject tints without its transparent surround filling in.
            overlay.blend === "normal" ? "source-atop" : compositeOperationFor(overlay.blend)
          }
          listening={false}
        />
      )}

      {gradientOverlay && (
        <Rect
          x={layer.x}
          y={layer.y}
          width={extent.width}
          height={extent.height}
          fillLinearGradientStartPoint={{ x: 0, y: 0 }}
          fillLinearGradientEndPoint={{
            x: Math.cos((gradientOverlay.angle * Math.PI) / 180) * extent.width,
            y: Math.sin((gradientOverlay.angle * Math.PI) / 180) * extent.height,
          }}
          fillLinearGradientColorStops={[0, gradientOverlay.from, 1, gradientOverlay.to]}
          opacity={gradientOverlay.opacity}
          globalCompositeOperation="source-atop"
          listening={false}
        />
      )}

      {maskCanvas && (
        <KonvaImage
          image={maskCanvas}
          x={0}
          y={0}
          width={doc.width}
          height={doc.height}
          globalCompositeOperation="destination-in"
          listening={false}
        />
      )}
    </>
  );

  return (
    <Group
      ref={groupRef}
      opacity={layer.opacity}
      globalCompositeOperation={compositeOperationFor(layer.blend)}
      listening={false}
    >
      {content}
    </Group>
  );
}

export { hasFx };
