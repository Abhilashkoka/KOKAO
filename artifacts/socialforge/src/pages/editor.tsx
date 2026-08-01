/**
 * The full-page image editor.
 *
 * Lives at /editor/:id, where the id is a content item. It owns three things
 * the panels and the canvas do not: loading (turning a stored layer document
 * plus a bitmap into an editable state), saving (uploading whatever raster
 * data is dirty, flattening, and writing back), and the keyboard.
 *
 * The save contract matches what the dialog already established, so a post
 * edited here still opens in the quick dialog and vice versa: `imagePath` gets
 * the flattened PNG, `imageLayers` gets the document that can rebuild it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import type Konva from "konva";
import { ArrowLeft, Check, Maximize, Minus, Plus, Redo2, Save, Undo2, X } from "lucide-react";
import {
  getGetContentQueryKey,
  useGetContent,
  useRequestUploadUrl,
  useUpdateContent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LogoLoader } from "@/components/logo-loader";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  migrateDoc,
  type ImageDoc,
  type Layer,
  type ShapeKind,
} from "@/lib/imageEditor/doc";
import type { Box } from "@/lib/imageEditor/geometry";
import { canvasToPngBytes, loadImage, storageUrl } from "@/lib/imageEditor/raster";
import { isTypingTarget, resolveShortcut } from "@/lib/imageEditor/shortcuts";
import { EditorCanvas } from "@/components/editor/canvas";
import { AiPanel } from "@/components/editor/ai-panel";
import { HistoryPanel, LayersPanel, PropertiesPanel, ToolRail } from "@/components/editor/panels";
import { useEditor } from "@/components/editor/use-editor";

const SHAPE_KINDS: ShapeKind[] = ["rect", "ellipse", "triangle", "star", "polygon", "line"];

export function EditorPage() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const id = Number(params.id);

  const { data: item, isLoading } = useGetContent(id, {
    query: {
      queryKey: getGetContentQueryKey(id),
      enabled: Number.isFinite(id) && id > 0,
    },
  });

  const [initial, setInitial] = useState<ImageDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Build the starting document once the bitmap is decoded: v1 documents never
  // stored a canvas size, so the image is the only source of truth for it.
  useEffect(() => {
    let cancelled = false;
    if (!item) return;
    const path = item.imagePath;
    if (!path) {
      setLoadError("This post has no image to edit.");
      return;
    }
    loadImage(storageUrl(path))
      .then((image) => {
        if (cancelled) return;
        setInitial(
          migrateDoc(item.imageLayers, path, image.naturalWidth, image.naturalHeight),
        );
      })
      .catch(() => {
        if (!cancelled) setLoadError("That image could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  if (loadError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
        {loadError}
        <Button type="button" variant="outline" size="sm" onClick={() => navigate("/library")}>
          Back to library
        </Button>
      </div>
    );
  }

  if (isLoading || !item || !initial) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <LogoLoader label="Opening the editor..." />
      </div>
    );
  }

  return <EditorShell key={id} contentId={id} title={item.title} initialDoc={initial} />;
}

function EditorShell({
  contentId,
  title,
  initialDoc,
}: {
  contentId: number;
  title: string;
  initialDoc: ImageDoc;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const editor = useEditor(initialDoc);
  const updateContent = useUpdateContent();
  const requestUploadUrl = useRequestUploadUrl();

  const [cropRect, setCropRect] = useState<Box | null>(null);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("layers");

  const stageRef = useRef<Konva.Stage | null>(null);
  const docLayerRef = useRef<Konva.Layer | null>(null);
  const fittedRef = useRef(false);

  const onStageReady = useCallback((stage: Konva.Stage | null, docLayer: Konva.Layer | null) => {
    stageRef.current = stage;
    docLayerRef.current = docLayer;
    if (stage && !fittedRef.current) {
      fittedRef.current = true;
      editor.zoomToFit({ width: stage.width(), height: stage.height() });
    }
  }, [editor]);

  /* ---------------- restore saved raster data ---------------- */

  useEffect(() => {
    const pending: Array<Promise<void>> = [];
    const walk = (layers: Layer[]) => {
      for (const layer of layers) {
        if (layer.maskPath) {
          pending.push(editor.raster.load("mask", layer.id, storageUrl(layer.maskPath)).catch(() => {}));
        }
        if (layer.type === "paint" && layer.objectPath) {
          pending.push(
            editor.raster.load("paint", layer.id, storageUrl(layer.objectPath)).catch(() => {}),
          );
        }
        if (layer.type === "group") walk(layer.children);
      }
    };
    walk(initialDoc.layers);
    if (pending.length > 0) void Promise.all(pending).then(() => editor.bumpRaster());
    // Runs once for the document this shell was mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- uploads ---------------- */

  const uploadBytes = useCallback(
    async (bytes: Uint8Array, name: string): Promise<string> => {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name, size: bytes.length, contentType: "image/png" },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: bytes as BodyInit,
        headers: { "Content-Type": "image/png" },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      return objectPath;
    },
    [requestUploadUrl],
  );

  /** Flatten the document layer exactly as it will be exported. */
  const flattenBytes = useCallback(async (): Promise<Uint8Array> => {
    const layer = docLayerRef.current;
    if (!layer) throw new Error("The canvas is not ready yet.");
    const canvas = layer.toCanvas({
      x: 0,
      y: 0,
      width: editor.doc.width,
      height: editor.doc.height,
      pixelRatio: 1,
    });
    return canvasToPngBytes(canvas);
  }, [editor.doc.width, editor.doc.height]);

  /** A storage path for the current composite — what the AI tools work from. */
  const getSourcePath = useCallback(async () => {
    const bytes = await flattenBytes();
    return uploadBytes(bytes, "editor-source.png");
  }, [flattenBytes, uploadBytes]);

  /* ---------------- save ---------------- */

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // Push every painted canvas that changed, and write its new path into
      // the document before the document is serialised.
      let doc = editor.doc;
      for (const entry of editor.raster.dirtyEntries()) {
        const bytes = await canvasToPngBytes(entry.canvas);
        const objectPath = await uploadBytes(bytes, `${entry.kind}-${entry.id}.png`);
        const patch =
          entry.kind === "mask" ? { maskPath: objectPath } : { objectPath };
        const apply = (layers: Layer[]): Layer[] =>
          layers.map((layer) => {
            if (layer.id === entry.id) return { ...layer, ...patch } as Layer;
            if (layer.type === "group") return { ...layer, children: apply(layer.children) };
            return layer;
          });
        doc = { ...doc, layers: apply(doc.layers) };
        editor.raster.markClean(entry.kind, entry.id);
      }

      const bytes = await flattenBytes();
      const imagePath = await uploadBytes(bytes, "edited-image.png");

      await updateContent.mutateAsync({
        id: contentId,
        data: {
          imagePath,
          imageLayers: doc as unknown as Record<string, unknown>,
        },
      });

      editor.replaceDoc(doc, "Save");
      editor.markSaved();
      toast({ title: "Image saved", description: "Your layers were saved with the post." });
    } catch (error) {
      toast({
        title: "Could not save",
        description: apiErrorMessage(error, error instanceof Error ? error.message : "Please try again."),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [contentId, editor, flattenBytes, toast, updateContent, uploadBytes]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const resolved = resolveShortcut(e);
      if (!resolved) return;
      e.preventDefault();
      if (resolved.kind === "tool" && resolved.tool) {
        editor.setTool(resolved.tool);
        return;
      }
      if (resolved.command === "save") {
        void handleSave();
        return;
      }
      if (resolved.command === "zoom-fit") {
        const stage = stageRef.current;
        if (stage) editor.zoomToFit({ width: stage.width(), height: stage.height() });
        return;
      }
      if (resolved.command === "add-mask" && editor.selectedLayer) {
        editor.raster.maskCanvas(editor.selectedLayer.id, editor.doc.width, editor.doc.height);
        editor.bumpRaster();
        return;
      }
      if (resolved.command) editor.runCommand(resolved.command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, handleSave]);

  /* ---------------- warn on leaving with unsaved work ---------------- */

  useEffect(() => {
    if (!editor.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor.dirty]);

  const zoomLabel = useMemo(() => `${Math.round(editor.zoom * 100)}%`, [editor.zoom]);
  const paintTool = editor.tool === "brush" || editor.tool === "eraser" || editor.tool === "mask-brush";

  return (
    <div className="flex h-screen max-h-screen min-h-0 flex-col bg-background" data-testid="editor-page">
      {/* Header */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => navigate("/library")}
          aria-label="Back to library"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="max-w-[240px] truncate text-sm font-medium">{title || "Untitled"}</span>
        {editor.dirty && <span className="text-[11px] text-muted-foreground">• unsaved</span>}

        <div className="flex-1" />

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={!editor.canUndo}
          onClick={() => editor.runCommand("undo")}
          aria-label="Undo"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={!editor.canRedo}
          onClick={() => editor.runCommand("redo")}
          aria-label="Redo"
        >
          <Redo2 className="h-4 w-4" />
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => editor.zoomBy(-1)}
          aria-label="Zoom out"
        >
          <Minus className="h-4 w-4" />
        </Button>
        <span className="w-12 text-center text-[11px] tabular-nums text-muted-foreground">{zoomLabel}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => editor.zoomBy(1)}
          aria-label="Zoom in"
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => {
            const stage = stageRef.current;
            if (stage) editor.zoomToFit({ width: stage.width(), height: stage.height() });
          }}
          aria-label="Fit to screen"
        >
          <Maximize className="h-4 w-4" />
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={() => void handleSave()}
          disabled={saving}
          data-testid="editor-save"
        >
          {saving ? <RippleSpinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          Save
        </Button>
      </header>

      {/* Tool options */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        {paintTool && (
          <>
            <Label className="text-[11px] text-muted-foreground">Size</Label>
            <Slider
              className="w-28"
              value={[editor.brush.size]}
              min={1}
              max={400}
              step={1}
              onValueChange={([v]) => editor.setBrush({ size: v })}
            />
            <span className="w-8 tabular-nums text-[11px] text-muted-foreground">{editor.brush.size}</span>
            <Label className="text-[11px] text-muted-foreground">Hardness</Label>
            <Slider
              className="w-24"
              value={[editor.brush.hardness]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={([v]) => editor.setBrush({ hardness: v })}
            />
            {editor.tool === "brush" && (
              <input
                type="color"
                value={editor.brush.color}
                onChange={(e) => editor.setBrush({ color: e.target.value })}
                className="h-6 w-10 cursor-pointer rounded border border-border bg-transparent"
                aria-label="Brush colour"
              />
            )}
            {editor.tool === "mask-brush" && (
              <span className="text-[11px] text-muted-foreground">
                Paints to hide. Hold Alt to paint back in.
              </span>
            )}
          </>
        )}

        {editor.tool === "shape" && (
          <div className="flex items-center gap-1">
            {SHAPE_KINDS.map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={shapeKind === kind ? "secondary" : "outline"}
                className="h-6 px-2 text-[11px] capitalize"
                onClick={() => setShapeKind(kind)}
              >
                {kind}
              </Button>
            ))}
          </div>
        )}

        {editor.tool === "crop" && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {cropRect
                ? `${Math.round(cropRect.width)} × ${Math.round(cropRect.height)}`
                : "Drag a rectangle on the canvas."}
            </span>
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!cropRect}
              onClick={() => {
                if (!cropRect) return;
                editor.cropTo(cropRect);
                setCropRect(null);
                editor.setTool("move");
              }}
              data-testid="editor-apply-crop"
            >
              <Check className="mr-1 h-3 w-3" /> Apply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={!cropRect}
              onClick={() => setCropRect(null)}
            >
              <X className="mr-1 h-3 w-3" /> Cancel
            </Button>
          </div>
        )}

        {editor.selection && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground">Selection</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => editor.runCommand("invert-selection")}
            >
              Invert
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => editor.clearSelectionMask()}
            >
              Deselect
            </Button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <ToolRail editor={editor} />

        <div className="min-w-0 flex-1">
          <EditorCanvas
            editor={editor}
            cropRect={cropRect}
            onCropRectChange={setCropRect}
            onPickColor={(hex) => editor.setBrush({ color: hex })}
            shapeKind={shapeKind}
            onStageReady={onStageReady}
          />
        </div>

        <aside className="flex w-72 shrink-0 flex-col border-l border-border">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="m-2 grid h-8 grid-cols-4">
              <TabsTrigger value="layers" className="text-[11px]">
                Layers
              </TabsTrigger>
              <TabsTrigger value="properties" className="text-[11px]">
                Style
              </TabsTrigger>
              <TabsTrigger value="ai" className="text-[11px]">
                AI
              </TabsTrigger>
              <TabsTrigger value="history" className="text-[11px]">
                History
              </TabsTrigger>
            </TabsList>
            <TabsContent value="layers" className="m-0 min-h-0 flex-1">
              <LayersPanel editor={editor} />
            </TabsContent>
            <TabsContent value="properties" className="m-0 min-h-0 flex-1">
              <PropertiesPanel editor={editor} />
            </TabsContent>
            <TabsContent value="ai" className="m-0 min-h-0 flex-1">
              <AiPanel editor={editor} getSourcePath={getSourcePath} contentId={contentId} />
            </TabsContent>
            <TabsContent value="history" className="m-0 min-h-0 flex-1">
              <HistoryPanel editor={editor} />
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}
