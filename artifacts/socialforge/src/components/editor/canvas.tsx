/**
 * The canvas: stage, layer tree assembly, and every pointer tool.
 *
 * Assembling the tree is the part with real rules in it. A flat list of layers
 * has to become a nested render where:
 *
 *  - a run of clipped layers is isolated with its base and trimmed to the
 *    base's alpha (Photoshop's clipping mask), while each clipped layer keeps
 *    its own blend mode;
 *  - an adjustment layer wraps everything already emitted in its sibling list,
 *    so it grades what is below it and nothing above;
 *  - a masked adjustment renders its subject twice — once clean, once graded
 *    and masked on top — because "apply this curve to half the picture" cannot
 *    be expressed as a single filtered pass.
 *
 * Tools are all built on the same two primitives: a document-space pointer
 * position, and a commit at pointer-up. Nothing writes to history mid-drag.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Group, Image as KonvaImage, Layer as KonvaLayer, Line, Rect, Stage, Transformer } from "react-konva";
import Konva from "konva";
import { buildFilterPlan } from "@/lib/imageEditor/adjustments";
import {
  BASE_LAYER_ID,
  findLayer,
  makeGradientLayer,
  makeShapeLayer,
  makeTextLayer,
  type ImageDoc,
  type Layer,
  type ShapeKind,
} from "@/lib/imageEditor/doc";
import { computeSnap, layerBounds, nextZoom, zoomAboutPoint, type Box } from "@/lib/imageEditor/geometry";
import {
  magicWand,
  maskBounds,
  rasterizeEllipse,
  rasterizePolygon,
  rasterizeRect,
  type SelectionMask,
  type SelectionMode,
} from "@/lib/imageEditor/selection";
import { LayerNode, registerEditorFilters } from "./layer-node";
import type { EditorApi } from "./use-editor";

/* ------------------------------------------------------------------ *
 * Isolation groups
 * ------------------------------------------------------------------ */

/**
 * A Konva group rendered to its own canvas first.
 *
 * Isolation is what makes `source-atop` and `destination-in` mean "within this
 * group" rather than "within everything drawn so far", which is the difference
 * between a clipping mask and a layer that eats the whole document.
 */
function IsolateGroup({
  box,
  filters,
  signature,
  children,
}: {
  box: Box;
  filters?: ReturnType<typeof buildFilterPlan>;
  signature: string;
  children: React.ReactNode;
}) {
  const ref = useRef<Konva.Group | null>(null);
  registerEditorFilters();

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (filters && filters.length > 0) {
      for (const step of filters) {
        for (const [attr, value] of Object.entries(step.attrs)) node.setAttr(attr, value);
      }
    }
    node.cache({ x: box.x, y: box.y, width: box.width, height: box.height });
    node.getLayer()?.batchDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <Group ref={ref} listening={false}>
      {children}
    </Group>
  );
}

/* ------------------------------------------------------------------ *
 * Tree assembly
 * ------------------------------------------------------------------ */

interface RenderContext {
  doc: ImageDoc;
  raster: EditorApi["raster"];
  rasterVersion: number;
  onContentReady: () => void;
}

function renderLayer(layer: Layer, ctx: RenderContext): React.ReactNode {
  if (layer.type === "group") {
    return (
      <LayerNode
        key={layer.id}
        layer={layer}
        doc={ctx.doc}
        raster={ctx.raster}
        rasterVersion={ctx.rasterVersion}
        onContentReady={ctx.onContentReady}
      >
        {renderSiblings(layer.children, ctx)}
      </LayerNode>
    );
  }
  return (
    <LayerNode
      key={layer.id}
      layer={layer}
      doc={ctx.doc}
      raster={ctx.raster}
      rasterVersion={ctx.rasterVersion}
      onContentReady={ctx.onContentReady}
    />
  );
}

function renderSiblings(layers: Layer[], ctx: RenderContext): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const box: Box = { x: 0, y: 0, width: ctx.doc.width, height: ctx.doc.height };
  let i = 0;

  while (i < layers.length) {
    const layer = layers[i];

    if (layer.type === "adjustment") {
      const below = out.splice(0, out.length);
      const plan = buildFilterPlan(layer.adjustments);
      const mask = layer.maskDisabled ? null : ctx.raster.getMask(layer.id);
      const signature = `${layer.id}|${JSON.stringify(layer.adjustments ?? {})}|${ctx.rasterVersion}|${box.width}x${box.height}|${layer.visible}`;

      if (!layer.visible || plan.length === 0) {
        out.push(<Group key={`adj-passthrough-${layer.id}`}>{below}</Group>);
      } else if (!mask) {
        out.push(
          <IsolateGroup key={`adj-${layer.id}`} box={box} filters={plan} signature={signature}>
            {below}
          </IsolateGroup>,
        );
      } else {
        // Two passes: the ungraded stack, then the graded copy showing only
        // where the adjustment's own mask allows. Compositing the difference
        // any other way would need a blend operator the canvas does not have.
        out.push(
          <Group key={`adj-pair-${layer.id}`} listening={false}>
            <Group key="clean">{below}</Group>
            <Group key="graded" opacity={layer.opacity}>
              <IsolateGroup box={box} filters={plan} signature={`${signature}|graded`}>
                {below}
                <KonvaImage
                  image={mask}
                  x={0}
                  y={0}
                  width={ctx.doc.width}
                  height={ctx.doc.height}
                  globalCompositeOperation="destination-in"
                  listening={false}
                />
              </IsolateGroup>
            </Group>
          </Group>,
        );
      }
      i += 1;
      continue;
    }

    // A clipping run: this layer plus every layer immediately above it that
    // is clipped to it.
    const run: Layer[] = [layer];
    let j = i + 1;
    while (j < layers.length && layers[j].clipped && layers[j].type !== "adjustment") {
      run.push(layers[j]);
      j += 1;
    }

    if (run.length > 1) {
      out.push(
        <IsolateGroup
          key={`clip-${layer.id}`}
          box={box}
          signature={`clip|${run.map((l) => `${l.id}:${l.visible}:${l.opacity}`).join(",")}|${ctx.rasterVersion}|${box.width}x${box.height}`}
        >
          {run.map((l) => renderLayer(l, ctx))}
          {/* Re-draw the base purely for its alpha: destination-in trims the
              whole run to the shape of the layer it is clipped to. */}
          <Group globalCompositeOperation="destination-in" listening={false}>
            {renderLayer({ ...layer, id: `${layer.id}__alpha`, blend: "normal", opacity: 1 }, ctx)}
          </Group>
        </IsolateGroup>,
      );
    } else {
      out.push(renderLayer(layer, ctx));
    }
    i = j;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Brush painting
 * ------------------------------------------------------------------ */

function paintStroke(
  canvas: HTMLCanvasElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { size: number; hardness: number; opacity: number; color: string; erase: boolean },
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = options.erase ? "destination-out" : "source-over";
  ctx.globalAlpha = options.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = options.size;

  if (options.hardness >= 0.99) {
    ctx.strokeStyle = options.color;
  } else {
    // A soft brush is a radial gradient dabbed along the segment; stroking with
    // a gradient is not possible, so the gradient becomes the stroke colour via
    // a pattern of one dab at the segment midpoint plus a hard core.
    const gradient = ctx.createRadialGradient(to.x, to.y, 0, to.x, to.y, options.size / 2);
    gradient.addColorStop(0, options.color);
    gradient.addColorStop(Math.max(0.01, options.hardness), options.color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.strokeStyle = gradient;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Canvas component
 * ------------------------------------------------------------------ */

export interface EditorCanvasProps {
  editor: EditorApi;
  /** Set when the crop tool has a pending rectangle awaiting confirmation. */
  onCropRectChange: (rect: Box | null) => void;
  cropRect: Box | null;
  onPickColor: (hex: string) => void;
  shapeKind: ShapeKind;
  /** Registers the document layer so the page can flatten it on save. */
  onStageReady: (stage: Konva.Stage | null, docLayer: Konva.Layer | null) => void;
}

type DragState =
  | { kind: "none" }
  | { kind: "marquee"; start: { x: number; y: number }; current: { x: number; y: number } }
  | { kind: "lasso"; points: number[] }
  | { kind: "paint"; last: { x: number; y: number }; layerId: string; mask: boolean; erase: boolean }
  | { kind: "pan"; start: { x: number; y: number }; origin: { x: number; y: number } }
  | { kind: "crop"; start: { x: number; y: number }; current: { x: number; y: number } }
  | { kind: "shape"; start: { x: number; y: number }; current: { x: number; y: number } };

export function EditorCanvas({
  editor,
  cropRect,
  onCropRectChange,
  onPickColor,
  shapeKind,
  onStageReady,
}: EditorCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const docLayerRef = useRef<Konva.Layer | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const handleRef = useRef<Konva.Rect | null>(null);

  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [drag, setDrag] = useState<DragState>({ kind: "none" });
  const [polygonPoints, setPolygonPoints] = useState<number[]>([]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [contentTick, setContentTick] = useState(0);
  const [guides, setGuides] = useState<Array<{ axis: "x" | "y"; position: number }>>([]);

  const { doc, raster, rasterVersion, tool, zoom, offset, selection, selectionVersion } = editor;

  const onContentReady = useCallback(() => setContentTick((t) => t + 1), []);

  /* ---------------- viewport measurement ---------------- */

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setViewport({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onStageReady(stageRef.current, docLayerRef.current);
    return () => onStageReady(null, null);
  }, [onStageReady, contentTick]);

  /* ---------------- space-to-pan ---------------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const activeTool = spaceHeld ? "hand" : tool;

  /* ---------------- transformer ---------------- */

  useLayoutEffect(() => {
    const transformer = transformerRef.current;
    const handle = handleRef.current;
    if (!transformer) return;
    const layer = editor.selectedIds.length === 1 ? findLayer(doc.layers, editor.selectedIds[0]) : null;
    if (!layer || layer.locked || activeTool !== "move" || !handle) {
      transformer.nodes([]);
    } else {
      // The transformer drives an invisible proxy rect rather than the layer's
      // own node: layer nodes are non-interactive (`listening={false}`) so that
      // the selection tools get every pointer event, and a node the transformer
      // cannot reach is a node it cannot resize.
      transformer.nodes([handle]);
    }
    transformer.getLayer()?.batchDraw();
  }, [editor.selectedIds, doc.layers, activeTool]);

  const selectedLayer = editor.selectedIds.length === 1 ? findLayer(doc.layers, editor.selectedIds[0]) : null;
  const selectedBounds = selectedLayer ? layerBounds(selectedLayer) : null;

  /* ---------------- selection overlay ---------------- */

  const selectionOverlay = useMemo(() => {
    if (!selection) return null;
    const canvas = document.createElement("canvas");
    canvas.width = doc.width;
    canvas.height = doc.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(doc.width, doc.height);
    for (let i = 0; i < selection.length; i += 1) {
      const o = i * 4;
      // A soft pastel wash rather than marching ants: the wash shows partial
      // coverage from feathering, which ants cannot represent at all.
      image.data[o] = 236;
      image.data[o + 1] = 173;
      image.data[o + 2] = 204;
      image.data[o + 3] = Math.round(selection[i] * 0.32);
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionVersion, doc.width, doc.height]);

  const selectionBox = useMemo(
    () => (selection ? maskBounds(selection, doc.width, doc.height) : null),
    [selection, doc.width, doc.height],
  );

  /* ---------------- pointer helpers ---------------- */

  const docPoint = (): { x: number; y: number } | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const pos = stage.getRelativePointerPosition();
    return pos ? { x: pos.x, y: pos.y } : null;
  };

  const selectionModeFor = (e: { evt: MouseEvent | TouchEvent }): SelectionMode => {
    const evt = e.evt as MouseEvent;
    if (evt.shiftKey) return "add";
    if (evt.altKey) return "subtract";
    return "replace";
  };

  /** Flattened document pixels, for the wand and the eyedropper. */
  const readComposite = (): { data: Uint8ClampedArray; width: number; height: number } | null => {
    const layer = docLayerRef.current;
    if (!layer) return null;
    const canvas = layer.toCanvas({
      x: 0,
      y: 0,
      width: doc.width,
      height: doc.height,
      pixelRatio: 1,
    });
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: image.data, width: canvas.width, height: canvas.height };
  };

  /* ---------------- pointer handlers ---------------- */

  const onPointerDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const point = docPoint();
    if (!point) return;
    const evt = e.evt as MouseEvent;

    switch (activeTool) {
      case "hand": {
        setDrag({
          kind: "pan",
          start: { x: evt.clientX ?? 0, y: evt.clientY ?? 0 },
          origin: { ...offset },
        });
        return;
      }
      case "zoom": {
        const stage = stageRef.current;
        const pointer = stage?.getPointerPosition();
        const direction: 1 | -1 = evt.altKey ? -1 : 1;
        const target = nextZoom(zoom, direction);
        if (pointer) editor.setOffset(zoomAboutPoint(offset, zoom, target, pointer));
        editor.setZoom(target);
        return;
      }
      case "move": {
        // Hit-test top-down through the document so clicking picks the layer
        // the user can see, not the one that happens to be first in the list.
        const hit = [...doc.layers].reverse().find((layer) => {
          if (!layer.visible || layer.locked) return false;
          const box = layerBounds(layer);
          return (
            point.x >= box.x &&
            point.x <= box.x + box.width &&
            point.y >= box.y &&
            point.y <= box.y + box.height
          );
        });
        editor.selectLayer(hit ? hit.id : null, evt.shiftKey);
        return;
      }
      case "marquee-rect":
      case "marquee-ellipse":
        setDrag({ kind: "marquee", start: point, current: point });
        return;
      case "lasso":
        setDrag({ kind: "lasso", points: [point.x, point.y] });
        return;
      case "polygon":
        setPolygonPoints((p) => [...p, point.x, point.y]);
        return;
      case "crop":
        setDrag({ kind: "crop", start: point, current: point });
        return;
      case "shape":
      case "gradient":
        setDrag({ kind: "shape", start: point, current: point });
        return;
      case "wand": {
        const composite = readComposite();
        if (!composite) return;
        const mask = magicWand(
          composite.data,
          composite.width,
          composite.height,
          point.x,
          point.y,
          32,
          !evt.metaKey && !evt.ctrlKey,
        );
        editor.applySelection(mask, selectionModeFor(e));
        return;
      }
      case "eyedropper": {
        const composite = readComposite();
        if (!composite) return;
        const index = (Math.floor(point.y) * composite.width + Math.floor(point.x)) * 4;
        const hex = `#${[0, 1, 2]
          .map((c) => composite.data[index + c].toString(16).padStart(2, "0"))
          .join("")}`;
        onPickColor(hex);
        return;
      }
      case "text": {
        const layer = makeTextLayer("Your text", Math.max(24, Math.round(doc.width / 16)));
        layer.x = point.x;
        layer.y = point.y;
        editor.addLayer(layer, "Add text");
        editor.setTool("move");
        return;
      }
      case "brush":
      case "eraser":
      case "mask-brush": {
        const target = editor.selectedIds[0];
        if (!target) return;
        const isMask = activeTool === "mask-brush";
        if (isMask) {
          raster.maskCanvas(target, doc.width, doc.height);
        } else {
          const layer = findLayer(doc.layers, target);
          if (!layer || layer.type !== "paint") return;
          raster.paintCanvas(target, doc.width, doc.height);
        }
        setDrag({
          kind: "paint",
          last: point,
          layerId: target,
          mask: isMask,
          erase: activeTool === "eraser" || (isMask && !evt.altKey),
        });
        return;
      }
      default:
        return;
    }
  };

  const onPointerMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (drag.kind === "none") return;
    const evt = e.evt as MouseEvent;

    if (drag.kind === "pan") {
      editor.setOffset({
        x: drag.origin.x + ((evt.clientX ?? 0) - drag.start.x),
        y: drag.origin.y + ((evt.clientY ?? 0) - drag.start.y),
      });
      return;
    }

    const point = docPoint();
    if (!point) return;

    switch (drag.kind) {
      case "marquee":
      case "crop":
      case "shape":
        setDrag({ ...drag, current: point });
        return;
      case "lasso":
        setDrag({ kind: "lasso", points: [...drag.points, point.x, point.y] });
        return;
      case "paint": {
        const canvas = drag.mask
          ? raster.maskCanvas(drag.layerId, doc.width, doc.height)
          : raster.paintCanvas(drag.layerId, doc.width, doc.height);
        paintStroke(canvas, drag.last, point, {
          size: editor.brush.size,
          hardness: editor.brush.hardness,
          opacity: editor.brush.opacity,
          color: drag.mask ? "#ffffff" : editor.brush.color,
          erase: drag.erase,
        });
        if (drag.mask) raster.markMaskDirty(drag.layerId);
        else raster.markPaintDirty(drag.layerId);
        editor.bumpRaster();
        setDrag({ ...drag, last: point });
        return;
      }
      default:
        return;
    }
  };

  const onPointerUp = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const mode = selectionModeFor(e);

    switch (drag.kind) {
      case "marquee": {
        const rect = {
          x: Math.min(drag.start.x, drag.current.x),
          y: Math.min(drag.start.y, drag.current.y),
          width: Math.abs(drag.current.x - drag.start.x),
          height: Math.abs(drag.current.y - drag.start.y),
        };
        if (rect.width > 1 && rect.height > 1) {
          const mask: SelectionMask =
            activeTool === "marquee-ellipse"
              ? rasterizeEllipse(rect, doc.width, doc.height)
              : rasterizeRect(rect, doc.width, doc.height);
          editor.applySelection(mask, mode);
        }
        break;
      }
      case "lasso": {
        if (drag.points.length >= 6) {
          editor.applySelection(rasterizePolygon(drag.points, doc.width, doc.height), mode);
        }
        break;
      }
      case "crop": {
        const rect = {
          x: Math.min(drag.start.x, drag.current.x),
          y: Math.min(drag.start.y, drag.current.y),
          width: Math.abs(drag.current.x - drag.start.x),
          height: Math.abs(drag.current.y - drag.start.y),
        };
        onCropRectChange(rect.width > 4 && rect.height > 4 ? rect : null);
        break;
      }
      case "shape": {
        const rect = {
          x: Math.min(drag.start.x, drag.current.x),
          y: Math.min(drag.start.y, drag.current.y),
          width: Math.abs(drag.current.x - drag.start.x),
          height: Math.abs(drag.current.y - drag.start.y),
        };
        if (rect.width > 2 && rect.height > 2) {
          if (activeTool === "gradient") {
            const layer = makeGradientLayer(rect.width, rect.height);
            layer.x = rect.x;
            layer.y = rect.y;
            layer.angle =
              (Math.atan2(drag.current.y - drag.start.y, drag.current.x - drag.start.x) * 180) / Math.PI;
            editor.addLayer(layer, "Add gradient");
          } else {
            const layer = makeShapeLayer(shapeKind, rect.width, rect.height);
            layer.x = rect.x;
            layer.y = rect.y;
            editor.addLayer(layer, "Add shape");
          }
          editor.setTool("move");
        }
        break;
      }
      default:
        break;
    }

    setDrag({ kind: "none" });
  };

  /** Close the polygon lasso on double click or Enter. */
  const closePolygon = useCallback(() => {
    if (polygonPoints.length >= 6) {
      editor.applySelection(rasterizePolygon(polygonPoints, doc.width, doc.height), "replace");
    }
    setPolygonPoints([]);
  }, [polygonPoints, editor, doc.width, doc.height]);

  useEffect(() => {
    if (tool !== "polygon" && polygonPoints.length > 0) setPolygonPoints([]);
  }, [tool, polygonPoints.length]);

  /* ---------------- wheel: zoom and pan ---------------- */

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const direction: 1 | -1 = e.evt.deltaY < 0 ? 1 : -1;
      const target = nextZoom(zoom, direction);
      if (pointer) editor.setOffset(zoomAboutPoint(offset, zoom, target, pointer));
      editor.setZoom(target);
      return;
    }
    editor.setOffset({ x: offset.x - e.evt.deltaX, y: offset.y - e.evt.deltaY });
  };

  /* ---------------- transform commit ---------------- */

  const commitHandleTransform = () => {
    const handle = handleRef.current;
    if (!handle || !selectedLayer || !selectedBounds) return;
    const scaleX = handle.scaleX();
    const scaleY = handle.scaleY();
    editor.patchLayer(
      selectedLayer.id,
      {
        x: selectedLayer.x + (handle.x() - selectedBounds.x),
        y: selectedLayer.y + (handle.y() - selectedBounds.y),
        rotation: selectedLayer.rotation + handle.rotation(),
        scaleX: selectedLayer.scaleX * scaleX,
        scaleY: selectedLayer.scaleY * scaleY,
      } as Partial<Layer>,
      "Transform layer",
    );
    handle.scaleX(1);
    handle.scaleY(1);
    handle.rotation(0);
  };

  const onHandleDragMove = () => {
    const handle = handleRef.current;
    if (!handle || !selectedLayer || !selectedBounds) return;
    const moving: Box = {
      x: handle.x(),
      y: handle.y(),
      width: selectedBounds.width,
      height: selectedBounds.height,
    };
    const others = doc.layers
      .filter((l) => l.id !== selectedLayer.id && l.visible)
      .map(layerBounds);
    const snap = computeSnap(moving, others, { width: doc.width, height: doc.height }, 6 / zoom);
    if (snap.dx !== 0 || snap.dy !== 0) {
      handle.x(handle.x() + snap.dx);
      handle.y(handle.y() + snap.dy);
    }
    setGuides(snap.guides);
  };

  const onHandleDragEnd = () => {
    setGuides([]);
    const handle = handleRef.current;
    if (!handle || !selectedLayer || !selectedBounds) return;
    editor.patchLayer(
      selectedLayer.id,
      {
        x: selectedLayer.x + (handle.x() - selectedBounds.x),
        y: selectedLayer.y + (handle.y() - selectedBounds.y),
      } as Partial<Layer>,
      "Move layer",
    );
  };

  const renderContext: RenderContext = { doc, raster, rasterVersion, onContentReady };

  const cursor =
    activeTool === "hand"
      ? drag.kind === "pan"
        ? "grabbing"
        : "grab"
      : activeTool === "move"
        ? "default"
        : activeTool === "text"
          ? "text"
          : "crosshair";

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-muted/40"
      data-testid="editor-canvas"
      onDoubleClick={() => activeTool === "polygon" && closePolygon()}
    >
      <Stage
        ref={stageRef}
        width={viewport.width}
        height={viewport.height}
        x={offset.x}
        y={offset.y}
        scaleX={zoom}
        scaleY={zoom}
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        onTouchStart={onPointerDown}
        onTouchMove={onPointerMove}
        onTouchEnd={onPointerUp}
        onWheel={onWheel}
        style={{ cursor }}
      >
        {/* Document */}
        <KonvaLayer ref={docLayerRef} listening={false}>
          <Rect
            x={0}
            y={0}
            width={doc.width}
            height={doc.height}
            fill="#ffffff"
            opacity={0}
            listening={false}
          />
          {renderSiblings(doc.layers, renderContext)}
        </KonvaLayer>

        {/* Overlays: never part of the exported image. */}
        <KonvaLayer>
          <Rect
            x={0}
            y={0}
            width={doc.width}
            height={doc.height}
            stroke="rgba(0,0,0,0.18)"
            strokeWidth={1 / zoom}
            listening={false}
          />

          {selectionOverlay && (
            <KonvaImage
              image={selectionOverlay}
              x={0}
              y={0}
              width={doc.width}
              height={doc.height}
              listening={false}
            />
          )}
          {selectionBox && (
            <Rect
              x={selectionBox.x}
              y={selectionBox.y}
              width={selectionBox.width}
              height={selectionBox.height}
              stroke="#ec4899"
              strokeWidth={1 / zoom}
              dash={[4 / zoom, 4 / zoom]}
              listening={false}
            />
          )}

          {drag.kind === "marquee" && (
            <Rect
              x={Math.min(drag.start.x, drag.current.x)}
              y={Math.min(drag.start.y, drag.current.y)}
              width={Math.abs(drag.current.x - drag.start.x)}
              height={Math.abs(drag.current.y - drag.start.y)}
              stroke="#ec4899"
              strokeWidth={1 / zoom}
              dash={[4 / zoom, 4 / zoom]}
              listening={false}
            />
          )}

          {drag.kind === "lasso" && (
            <Line points={drag.points} stroke="#ec4899" strokeWidth={1 / zoom} listening={false} />
          )}

          {polygonPoints.length >= 2 && (
            <Line
              points={polygonPoints}
              stroke="#ec4899"
              strokeWidth={1 / zoom}
              closed={false}
              listening={false}
            />
          )}

          {(drag.kind === "crop" || cropRect) && (
            <Rect
              x={drag.kind === "crop" ? Math.min(drag.start.x, drag.current.x) : (cropRect?.x ?? 0)}
              y={drag.kind === "crop" ? Math.min(drag.start.y, drag.current.y) : (cropRect?.y ?? 0)}
              width={
                drag.kind === "crop" ? Math.abs(drag.current.x - drag.start.x) : (cropRect?.width ?? 0)
              }
              height={
                drag.kind === "crop" ? Math.abs(drag.current.y - drag.start.y) : (cropRect?.height ?? 0)
              }
              stroke="#0ea5e9"
              strokeWidth={1.5 / zoom}
              dash={[6 / zoom, 4 / zoom]}
              listening={false}
            />
          )}

          {drag.kind === "shape" && (
            <Rect
              x={Math.min(drag.start.x, drag.current.x)}
              y={Math.min(drag.start.y, drag.current.y)}
              width={Math.abs(drag.current.x - drag.start.x)}
              height={Math.abs(drag.current.y - drag.start.y)}
              stroke="#0ea5e9"
              strokeWidth={1 / zoom}
              listening={false}
            />
          )}

          {guides.map((guide) => (
            <Line
              key={`${guide.axis}-${guide.position}`}
              points={
                guide.axis === "x"
                  ? [guide.position, 0, guide.position, doc.height]
                  : [0, guide.position, doc.width, guide.position]
              }
              stroke="#ec4899"
              strokeWidth={1 / zoom}
              listening={false}
            />
          ))}

          {selectedBounds && selectedLayer && !selectedLayer.locked && activeTool === "move" && (
            <Rect
              ref={handleRef}
              x={selectedBounds.x}
              y={selectedBounds.y}
              width={selectedBounds.width}
              height={selectedBounds.height}
              fill="transparent"
              stroke="#ec4899"
              strokeWidth={1 / zoom}
              draggable
              onDragMove={onHandleDragMove}
              onDragEnd={onHandleDragEnd}
              onTransformEnd={commitHandleTransform}
            />
          )}

          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio={false}
            anchorSize={7}
            anchorStroke="#ec4899"
            anchorFill="#ffffff"
            borderStroke="#ec4899"
            borderDash={[3, 3]}
          />
        </KonvaLayer>
      </Stage>

      {editor.doc.layers.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          This document has no layers.
        </div>
      )}
    </div>
  );
}

export { BASE_LAYER_ID };
