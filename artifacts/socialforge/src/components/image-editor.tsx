import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Text as KonvaText, Line, Transformer, Rect } from "react-konva";
import type Konva from "konva";
import useImage from "use-image";
import { useEditImage, useRequestUploadUrl } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { LogoLoader } from "@/components/logo-loader";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  Type as TypeIcon,
  ImagePlus,
  Wand2,
  Trash2,
  ArrowUp,
  ArrowDown,
  MousePointer2,
} from "lucide-react";

/**
 * Layered image editor for content images.
 *
 * Layers live in base-image NATURAL pixel coordinates and are persisted as an
 * opaque versioned JSON document (content_items.imageLayers) so an image can
 * be re-opened and re-edited later. Saving flattens the canvas to a PNG at
 * natural resolution, uploads it as a NEW storage object, and hands both the
 * new path and the layer document back to the caller.
 *
 * Three tools:
 *  - Text layers (editable content/size/color via the side panel)
 *  - Element layers (brand logos or any uploaded image, via presigned upload)
 *  - AI repair: brush over a region + a prompt -> POST /ai/edit-image
 *    (mask-based inpainting; billed like one image generation)
 */

export interface TextLayer {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fill: string;
  fontFamily: string;
  fontStyle: string;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface ElementLayer {
  id: string;
  type: "image";
  /** /objects/... storage path of the uploaded element. */
  objectPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /**
   * The three fields below are OPTIONAL and additive, written by layered
   * generation and left undefined by hand-added elements. An older document
   * that lacks them renders exactly as it did before.
   */
  opacity?: number;
  /** "multiply" is how a generated contact-shadow layer sits on the backdrop. */
  blend?: "normal" | "multiply";
  /** Friendly label for the layer list ("ceramic cup"). */
  name?: string;
}

export type EditorLayer = TextLayer | ElementLayer;

export interface ImageLayerDoc {
  version: 1;
  /** Storage path of the base image these layers were authored against. */
  basePath: string;
  layers: EditorLayer[];
}

export interface ImageEditorSaveResult {
  /** Storage path of the flattened PNG (new object). */
  imagePath: string;
  /** Base64 of the flattened PNG for instant preview. */
  b64: string;
  /** The layer document to persist for future re-editing. */
  layers: ImageLayerDoc;
}

interface ImageEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Storage path (/objects/...) of the image to edit. */
  imagePath: string;
  /** Optional freshly-generated base64 (used instead of fetching the path). */
  imageB64?: string | null;
  /** Previously saved layer document, if any. */
  initialLayers?: unknown;
  onSave: (result: ImageEditorSaveResult) => void;
}

const EDITOR_MAX_W = 560;
const EDITOR_MAX_H = 480;
const FONT_FAMILY = "Inter, system-ui, sans-serif";

function newId() {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Parse a persisted layer doc. The doc's basePath points at the ORIGINAL
 * (pre-flatten) base image the layers were authored against — the post's
 * imagePath holds the flattened result. Re-editing must resume on that
 * original base so layers stay live instead of being baked in twice.
 */
function parseInitialLayers(doc: unknown): { basePath: string | null; layers: EditorLayer[] } {
  const none = { basePath: null, layers: [] as EditorLayer[] };
  if (!doc || typeof doc !== "object") return none;
  const d = doc as Partial<ImageLayerDoc>;
  if (d.version !== 1 || !Array.isArray(d.layers)) return none;
  const layers = d.layers.filter(
    (l): l is EditorLayer =>
      !!l && typeof l === "object" && ((l as EditorLayer).type === "text" || (l as EditorLayer).type === "image"),
  );
  return { basePath: typeof d.basePath === "string" && d.basePath ? d.basePath : null, layers };
}

function srcFor(path: string | null, b64?: string | null): string | undefined {
  if (b64) return `data:image/png;base64,${b64}`;
  if (path) return `/api/storage${path}`;
  return undefined;
}

/** One uploaded element rendered on the canvas. */
function ElementNode({
  layer,
  isSelected,
  onSelect,
  onChange,
  registerNode,
  draggable,
}: {
  layer: ElementLayer;
  isSelected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<ElementLayer>) => void;
  registerNode: (id: string, node: Konva.Node | null) => void;
  draggable: boolean;
}) {
  const [img] = useImage(`/api/storage${layer.objectPath}`);
  return (
    <KonvaImage
      image={img}
      x={layer.x}
      y={layer.y}
      width={layer.width}
      height={layer.height}
      globalCompositeOperation={layer.blend === "multiply" ? "multiply" : undefined}
      rotation={layer.rotation}
      scaleX={layer.scaleX}
      scaleY={layer.scaleY}
      draggable={draggable}
      onClick={onSelect}
      onTap={onSelect}
      ref={(node) => registerNode(layer.id, node)}
      onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
      onTransformEnd={(e) => {
        const n = e.target;
        onChange({
          x: n.x(),
          y: n.y(),
          rotation: n.rotation(),
          scaleX: n.scaleX(),
          scaleY: n.scaleY(),
        });
      }}
      opacity={(layer.opacity ?? 1) * (isSelected ? 1 : 0.999)}
    />
  );
}

export function ImageEditorDialog({
  open,
  onOpenChange,
  imagePath,
  imageB64,
  initialLayers,
  onSave,
}: ImageEditorDialogProps) {
  const { toast } = useToast();
  const editImage = useEditImage();
  const requestUploadUrl = useRequestUploadUrl();

  // Base image: may be replaced in-place by an AI repair round.
  const [basePath, setBasePath] = useState(imagePath);
  const [baseB64, setBaseB64] = useState<string | null>(imageB64 ?? null);
  const [baseImg] = useImage(srcFor(basePath, baseB64) ?? "");

  const [layers, setLayers] = useState<EditorLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "repair">("select");
  const [repairPrompt, setRepairPrompt] = useState("");
  const [brushSize, setBrushSize] = useState(48);
  const [strokes, setStrokes] = useState<{ points: number[]; size: number }[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingElement, setUploadingElement] = useState(false);

  const stageRef = useRef<Konva.Stage | null>(null);
  const repairLayerRef = useRef<Konva.Layer | null>(null);
  const trRef = useRef<Konva.Transformer | null>(null);
  const nodeMap = useRef<Map<string, Konva.Node>>(new Map());
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Reset editor state each time it opens for a (possibly different) image.
  useEffect(() => {
    if (!open) return;
    const parsed = parseInitialLayers(initialLayers);
    if (parsed.layers.length > 0 && parsed.basePath) {
      // Resume editing on the original base image; the current imagePath is
      // the flattened output and already has these layers baked in.
      setBasePath(parsed.basePath);
      setBaseB64(null);
      setLayers(parsed.layers);
    } else {
      setBasePath(imagePath);
      setBaseB64(imageB64 ?? null);
      setLayers([]);
    }
    setSelectedId(null);
    setTool("select");
    setStrokes([]);
    setRepairPrompt("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imagePath]);

  const naturalW = baseImg?.naturalWidth ?? 1024;
  const naturalH = baseImg?.naturalHeight ?? 1024;
  const scale = Math.min(EDITOR_MAX_W / naturalW, EDITOR_MAX_H / naturalH, 1);
  const displayW = Math.round(naturalW * scale);
  const displayH = Math.round(naturalH * scale);

  const selected = useMemo(
    () => layers.find((l) => l.id === selectedId) ?? null,
    [layers, selectedId],
  );

  const registerNode = useCallback((id: string, node: Konva.Node | null) => {
    if (node) nodeMap.current.set(id, node);
    else nodeMap.current.delete(id);
  }, []);

  // Attach transformer to the selected node.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedId ? nodeMap.current.get(selectedId) : null;
    tr.nodes(node && tool === "select" ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, layers, tool]);

  const patchLayer = (id: string, patch: Partial<EditorLayer>) => {
    setLayers((ls) => ls.map((l) => (l.id === id ? ({ ...l, ...patch } as EditorLayer) : l)));
  };

  const addText = () => {
    const layer: TextLayer = {
      id: newId(),
      type: "text",
      text: "Your text",
      x: Math.round(naturalW * 0.1),
      y: Math.round(naturalH * 0.1),
      fontSize: Math.max(24, Math.round(naturalW / 16)),
      fill: "#ffffff",
      fontFamily: FONT_FAMILY,
      fontStyle: "bold",
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    };
    setLayers((ls) => [...ls, layer]);
    setSelectedId(layer.id);
    setTool("select");
  };

  const handleElementUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Not an image", description: "Please pick an image file.", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Elements must be under 5 MB.", variant: "destructive" });
      return;
    }
    setUploadingElement(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      // Size the element to ~1/3 of the canvas width, keeping aspect ratio.
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const probe = new window.Image();
        probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
        probe.onerror = () => reject(new Error("Could not read the image"));
        probe.src = URL.createObjectURL(file);
      });
      const targetW = naturalW / 3;
      const ratio = targetW / dims.w;
      const layer: ElementLayer = {
        id: newId(),
        type: "image",
        objectPath,
        x: Math.round(naturalW * 0.33),
        y: Math.round(naturalH * 0.33),
        width: Math.round(dims.w * ratio),
        height: Math.round(dims.h * ratio),
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      };
      setLayers((ls) => [...ls, layer]);
      setSelectedId(layer.id);
      setTool("select");
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploadingElement(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeSelected = () => {
    if (!selectedId) return;
    setLayers((ls) => ls.filter((l) => l.id !== selectedId));
    setSelectedId(null);
  };

  const moveSelected = (dir: 1 | -1) => {
    if (!selectedId) return;
    setLayers((ls) => {
      const idx = ls.findIndex((l) => l.id === selectedId);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= ls.length) return ls;
      const next = [...ls];
      const [item] = next.splice(idx, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  // ---- AI repair (mask inpainting) ----

  const stagePos = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const pos = e.target.getStage()?.getPointerPosition();
    if (!pos) return null;
    return { x: pos.x / scale, y: pos.y / scale };
  };

  const onPointerDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (tool !== "repair") {
      // Clicking empty space deselects.
      if (e.target === e.target.getStage() || e.target.name() === "base-image") {
        setSelectedId(null);
      }
      return;
    }
    const p = stagePos(e);
    if (!p) return;
    setDrawing(true);
    setStrokes((s) => [...s, { points: [p.x, p.y], size: brushSize / scale }]);
  };

  const onPointerMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (tool !== "repair" || !drawing) return;
    const p = stagePos(e);
    if (!p) return;
    setStrokes((s) => {
      const next = [...s];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, points: [...last.points, p.x, p.y] };
      return next;
    });
  };

  const onPointerUp = () => setDrawing(false);

  const buildMaskB64 = (): string => {
    // Opaque black everywhere; brushed regions punched TRANSPARENT (OpenAI
    // mask semantics: transparent = regenerate).
    const canvas = document.createElement("canvas");
    canvas.width = naturalW;
    canvas.height = naturalH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, naturalW, naturalH);
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    for (const stroke of strokes) {
      ctx.lineWidth = stroke.size;
      ctx.beginPath();
      const pts = stroke.points;
      if (pts.length < 4) {
        // Single dab.
        ctx.fillStyle = "rgba(0,0,0,1)";
        ctx.arc(pts[0], pts[1], stroke.size / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    }
    return canvas.toDataURL("image/png").split(",")[1];
  };

  const applyRepair = () => {
    if (strokes.length === 0) {
      toast({ title: "Paint the area first", description: "Brush over the part of the image you want the AI to redo." });
      return;
    }
    if (!repairPrompt.trim()) {
      toast({ title: "Describe the change", description: "Tell the AI what the painted area should become." });
      return;
    }
    editImage.mutate(
      { data: { imagePath: basePath, maskB64: buildMaskB64(), prompt: repairPrompt.trim() } },
      {
        onSuccess: (res) => {
          setBasePath(res.imagePath);
          setBaseB64(res.b64Json);
          setStrokes([]);
          setRepairPrompt("");
          setTool("select");
          toast({ title: "Area regenerated", description: "Save to keep the result. This used one image generation." });
        },
        onError: (err) => {
          toast({
            title: "AI repair failed",
            description: apiErrorMessage(err, "The image provider rejected the edit."),
            variant: "destructive",
          });
        },
      },
    );
  };

  // ---- Save (flatten + upload) ----

  const handleSave = async () => {
    const stage = stageRef.current;
    if (!stage || !baseImg) return;
    setSaving(true);
    try {
      setSelectedId(null);
      trRef.current?.nodes([]);
      if (repairLayerRef.current) repairLayerRef.current.visible(false);
      stage.batchDraw();
      const dataUrl = stage.toDataURL({ pixelRatio: 1 / scale, mimeType: "image/png" });
      if (repairLayerRef.current) repairLayerRef.current.visible(true);

      const b64 = dataUrl.split(",")[1];
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: "edited-image.png", size: bytes.length, contentType: "image/png" },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: bytes,
        headers: { "Content-Type": "image/png" },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      onSave({
        imagePath: objectPath,
        b64,
        layers: { version: 1, basePath, layers },
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Could not save the image",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const selectedText = selected?.type === "text" ? selected : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-4xl" data-testid="image-editor-dialog">
        <DialogHeader>
          <DialogTitle>Edit image</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col md:flex-row gap-4">
          {/* Canvas */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Button
                type="button" size="sm" variant={tool === "select" ? "default" : "outline"}
                className="h-8 px-2 text-xs" onClick={() => setTool("select")}
                data-testid="editor-tool-select"
              >
                <MousePointer2 className="h-3.5 w-3.5 mr-1" /> Select
              </Button>
              <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={addText} data-testid="editor-add-text">
                <TypeIcon className="h-3.5 w-3.5 mr-1" /> Add text
              </Button>
              <Button
                type="button" size="sm" variant="outline" className="h-8 px-2 text-xs"
                onClick={() => fileRef.current?.click()} disabled={uploadingElement}
                data-testid="editor-add-element"
              >
                {uploadingElement ? <RippleSpinner className="h-3.5 w-3.5 mr-1" /> : <ImagePlus className="h-3.5 w-3.5 mr-1" />}
                Add logo / element
              </Button>
              <Button
                type="button" size="sm" variant={tool === "repair" ? "default" : "outline"}
                className="h-8 px-2 text-xs" onClick={() => setTool(tool === "repair" ? "select" : "repair")}
                data-testid="editor-tool-repair"
              >
                <Wand2 className="h-3.5 w-3.5 mr-1" /> AI repair
              </Button>
              <input
                ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleElementUpload(f); }}
              />
            </div>
            <div className="relative rounded-md border bg-muted/30 overflow-hidden inline-block" style={{ width: displayW, height: displayH }}>
              {!baseImg ? (
                <div className="absolute inset-0 flex items-center justify-center"><LogoLoader label="Loading image..." /></div>
              ) : (
                <Stage
                  ref={stageRef}
                  width={displayW}
                  height={displayH}
                  scaleX={scale}
                  scaleY={scale}
                  onMouseDown={onPointerDown}
                  onMouseMove={onPointerMove}
                  onMouseUp={onPointerUp}
                  onTouchStart={onPointerDown}
                  onTouchMove={onPointerMove}
                  onTouchEnd={onPointerUp}
                  style={{ cursor: tool === "repair" ? "crosshair" : "default" }}
                >
                  <Layer>
                    <KonvaImage image={baseImg} width={naturalW} height={naturalH} name="base-image" />
                    {layers.map((layer) =>
                      layer.type === "text" ? (
                        <KonvaText
                          key={layer.id}
                          text={layer.text}
                          x={layer.x}
                          y={layer.y}
                          fontSize={layer.fontSize}
                          fill={layer.fill}
                          fontFamily={layer.fontFamily}
                          fontStyle={layer.fontStyle}
                          rotation={layer.rotation}
                          scaleX={layer.scaleX}
                          scaleY={layer.scaleY}
                          draggable={tool === "select"}
                          onClick={() => setSelectedId(layer.id)}
                          onTap={() => setSelectedId(layer.id)}
                          ref={(node) => registerNode(layer.id, node)}
                          onDragEnd={(e) => patchLayer(layer.id, { x: e.target.x(), y: e.target.y() })}
                          onTransformEnd={(e) => {
                            const n = e.target;
                            patchLayer(layer.id, {
                              x: n.x(), y: n.y(), rotation: n.rotation(),
                              scaleX: n.scaleX(), scaleY: n.scaleY(),
                            });
                          }}
                        />
                      ) : (
                        <ElementNode
                          key={layer.id}
                          layer={layer}
                          isSelected={selectedId === layer.id}
                          onSelect={() => setSelectedId(layer.id)}
                          onChange={(patch) => patchLayer(layer.id, patch)}
                          registerNode={registerNode}
                          draggable={tool === "select"}
                        />
                      ),
                    )}
                    <Transformer ref={trRef} rotateEnabled keepRatio={false} />
                  </Layer>
                  <Layer ref={repairLayerRef} listening={false}>
                    {tool === "repair" && (
                      <Rect x={0} y={0} width={naturalW} height={naturalH} fill="rgba(0,0,0,0.15)" />
                    )}
                    {strokes.map((s, i) => (
                      <Line
                        key={i}
                        points={s.points}
                        stroke="rgba(236,72,153,0.6)"
                        strokeWidth={s.size}
                        lineCap="round"
                        lineJoin="round"
                      />
                    ))}
                  </Layer>
                </Stage>
              )}
              {editImage.isPending && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60" data-testid="editor-repair-loading">
                  <LogoLoader label="Regenerating the painted area..." />
                </div>
              )}
            </div>
          </div>

          {/* Side panel */}
          <div className="w-full md:w-64 shrink-0 space-y-4">
            {tool === "repair" ? (
              <div className="space-y-3" data-testid="editor-repair-panel">
                <p className="text-xs text-muted-foreground">
                  Brush over the part of the image to redo, describe what it should become, then apply. Uses one image generation.
                </p>
                <div className="space-y-1.5">
                  <Label className="text-xs">Brush size</Label>
                  <input
                    type="range" min={12} max={120} step={4} value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">What should this area become?</Label>
                  <Input
                    value={repairPrompt}
                    onChange={(e) => setRepairPrompt(e.target.value)}
                    placeholder="e.g. a clear blue sky"
                    data-testid="editor-repair-prompt"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" className="h-8 text-xs" onClick={applyRepair} disabled={editImage.isPending} data-testid="editor-repair-apply">
                    {editImage.isPending ? <RippleSpinner className="h-3.5 w-3.5 mr-1" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
                    Apply AI repair
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setStrokes([])} disabled={strokes.length === 0}>
                    Clear brush
                  </Button>
                </div>
              </div>
            ) : selected ? (
              <div className="space-y-3" data-testid="editor-layer-panel">
                <p className="text-xs font-medium">{selected.type === "text" ? "Text layer" : "Element layer"}</p>
                {selectedText && (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Text</Label>
                      <Input
                        value={selectedText.text}
                        onChange={(e) => patchLayer(selectedText.id, { text: e.target.value })}
                        data-testid="editor-text-input"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Size</Label>
                      <input
                        type="range" min={12} max={Math.max(200, Math.round(naturalW / 4))} step={2}
                        value={selectedText.fontSize}
                        onChange={(e) => patchLayer(selectedText.id, { fontSize: Number(e.target.value) })}
                        className="w-full accent-primary"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Color</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={selectedText.fill}
                          onChange={(e) => patchLayer(selectedText.id, { fill: e.target.value })}
                          className="h-8 w-12 rounded border cursor-pointer bg-transparent"
                          data-testid="editor-text-color"
                        />
                        <Button
                          type="button" size="sm" variant="outline" className="h-8 text-xs px-2"
                          onClick={() => patchLayer(selectedText.id, { fontStyle: selectedText.fontStyle === "bold" ? "normal" : "bold" })}
                        >
                          {selectedText.fontStyle === "bold" ? "Bold ✓" : "Bold"}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
                <div className="flex gap-2 flex-wrap">
                  <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => moveSelected(1)} title="Bring forward">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => moveSelected(-1)} title="Send backward">
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={removeSelected} data-testid="editor-delete-layer">
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Add text or upload a logo/element, then drag, resize, and rotate it on the image. Use AI repair to redo part of the picture.
                </p>
                {layers.length > 0 && (
                  <div className="space-y-1" data-testid="editor-layer-list">
                    <p className="text-xs font-medium">Layers</p>
                    {[...layers].reverse().map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => setSelectedId(l.id)}
                        className="w-full text-left text-xs rounded border px-2 py-1.5 hover:bg-muted/50 truncate"
                      >
                        {l.type === "text" ? `Text: ${(l as TextLayer).text}` : "Element"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving || !baseImg} data-testid="editor-save">
            {saving ? <RippleSpinner className="h-4 w-4 mr-1" /> : null}
            Save image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
