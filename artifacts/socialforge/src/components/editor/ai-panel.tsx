/**
 * The generative tools.
 *
 * Two decisions shape this panel.
 *
 * First, every operation runs against a freshly flattened snapshot of the
 * document, not against the original file. The user is looking at their layers,
 * their masks and their adjustments; asking the model to fill a hole in an
 * image that has none of those would come back matching a picture nobody can
 * see. Flattening first also guarantees the mask and the source are the same
 * size, which is the failure the server rejects most often.
 *
 * Second, results come back as a NEW layer wherever that is possible. A
 * generative fill that replaced the document would throw away every layer the
 * user built to get there, and it would make "I preferred it before" a
 * question of undo depth rather than of turning a layer off. Fill, remove and
 * background replacement all land as a masked layer on top. Expand and enlarge
 * cannot work that way — they change the canvas, so what comes back genuinely
 * is the new document — and the panel says so before it runs them.
 */

import { useState } from "react";
import { Sparkles, Scissors, Eraser, Maximize2, Wand2, ZoomIn } from "lucide-react";
import { useRunImageOp } from "@workspace/api-client-react";
import type { ImageOpRequest, ImageOpResult } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  BASE_LAYER_ID,
  baseLayerDefaults,
  makeImageLayer,
  type ImageDoc,
  type ImageLayer,
  type Layer,
} from "@/lib/imageEditor/doc";
import { invertMask, maskToRGBA, type SelectionMask } from "@/lib/imageEditor/selection";
import type { EditorApi } from "./use-editor";

type OpId = ImageOpRequest["op"];

interface OpDef {
  id: OpId;
  label: string;
  icon: typeof Sparkles;
  needsSelection: boolean;
  needsPrompt: boolean;
  /** True when the result replaces the whole document rather than adding a layer. */
  flattens: boolean;
  units: number;
  hint: string;
}

const OPS: OpDef[] = [
  {
    id: "fill",
    label: "Generative fill",
    icon: Sparkles,
    needsSelection: true,
    needsPrompt: true,
    flattens: false,
    units: 1,
    hint: "Select an area, describe what belongs there. Arrives as a new masked layer.",
  },
  {
    id: "remove",
    label: "Remove object",
    icon: Eraser,
    needsSelection: true,
    needsPrompt: false,
    flattens: false,
    units: 1,
    hint: "Select the thing you want gone. The background is continued through it.",
  },
  {
    id: "replace-background",
    label: "Replace background",
    icon: Wand2,
    needsSelection: true,
    needsPrompt: true,
    flattens: false,
    units: 1,
    hint: "Select the SUBJECT to keep, then describe the new background.",
  },
  {
    id: "cutout",
    label: "Cut out subject",
    icon: Scissors,
    needsSelection: false,
    needsPrompt: false,
    flattens: false,
    units: 1,
    hint: "Extracts the subject onto its own transparent layer.",
  },
  {
    id: "expand",
    label: "Expand canvas",
    icon: Maximize2,
    needsSelection: false,
    needsPrompt: false,
    flattens: true,
    units: 1,
    hint: "Outpaints into new space. Flattens the document — the canvas changes shape.",
  },
  {
    id: "enlarge",
    label: "Enlarge",
    icon: ZoomIn,
    needsSelection: false,
    needsPrompt: false,
    flattens: true,
    units: 0,
    hint: "High-quality resample, no AI and no credit. Flattens the document.",
  },
];

export interface AiPanelProps {
  editor: EditorApi;
  /** Flattens the current document and returns its storage path. */
  getSourcePath: () => Promise<string>;
}

export function AiPanel({ editor, getSourcePath }: AiPanelProps) {
  const { toast } = useToast();
  const runOp = useRunImageOp();
  const [op, setOp] = useState<OpId>("fill");
  const [prompt, setPrompt] = useState("");
  const [pad, setPad] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const [scale, setScale] = useState<2 | 4>(2);
  const [busy, setBusy] = useState(false);

  const def = OPS.find((o) => o.id === op) ?? OPS[0];
  const hasSelection = !!editor.selection;

  /** Selection to the provider's mask convention: transparent = regenerate. */
  const buildMask = (selection: SelectionMask, invert: boolean): string => {
    const canvas = document.createElement("canvas");
    canvas.width = editor.doc.width;
    canvas.height = editor.doc.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not build the mask.");
    const rgba = maskToRGBA(invert ? invertMask(selection) : selection, "inpaint");
    const image = ctx.createImageData(canvas.width, canvas.height);
    image.data.set(rgba);
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  };

  const applyResult = (result: ImageOpResult) => {
    if (op === "cutout") {
      for (const extracted of result.layers ?? []) {
        const layer = makeImageLayer(
          extracted.objectPath,
          extracted.width,
          extracted.height,
          extracted.name,
        );
        layer.x = extracted.x;
        layer.y = extracted.y;
        editor.addLayer(layer, "Cut out subject");
      }
      return;
    }

    if (!result.imagePath) {
      toast({ title: "Nothing came back", description: "The provider returned no image.", variant: "destructive" });
      return;
    }

    if (def.flattens) {
      // Expand and enlarge change the canvas, and the returned frame already
      // contains every layer that was flattened into it. Keeping the old
      // layers would draw them twice.
      const base: ImageLayer = {
        ...baseLayerDefaults("image", "Background"),
        id: BASE_LAYER_ID,
        type: "image",
        objectPath: result.imagePath,
        width: result.width,
        height: result.height,
      };
      const next: ImageDoc = {
        version: 2,
        width: result.width,
        height: result.height,
        basePath: result.imagePath,
        layers: [base],
      };
      editor.raster.clear();
      editor.bumpRaster();
      editor.replaceDoc(next, def.label);
      editor.clearSelectionMask();
      return;
    }

    // Non-destructive path: the result lands on top, showing only through the
    // region the user selected, so every layer underneath survives and the
    // whole operation can be turned off with the eye icon.
    const layer = makeImageLayer(result.imagePath, result.width, result.height, def.label);
    const topOfStack = editor.doc.layers[editor.doc.layers.length - 1];
    editor.setSelectedIds(topOfStack ? [topOfStack.id] : []);
    editor.addLayer(layer as Layer, def.label);

    if (editor.selection) {
      editor.raster.setMaskFromSelection(
        layer.id,
        op === "replace-background" ? invertMask(editor.selection) : editor.selection,
        editor.doc.width,
        editor.doc.height,
      );
      editor.bumpRaster();
    }
  };

  const run = async () => {
    if (def.needsSelection && !editor.selection) {
      toast({
        title: "Make a selection first",
        description: "Use the marquee, lasso or magic wand to mark the area.",
      });
      return;
    }
    if (def.needsPrompt && !prompt.trim()) {
      toast({ title: "Describe what you want", description: def.hint });
      return;
    }
    if (op === "expand" && pad.left + pad.right + pad.top + pad.bottom <= 0) {
      toast({ title: "Pick a direction", description: "Choose at least one edge to expand into." });
      return;
    }

    setBusy(true);
    try {
      const imagePath = await getSourcePath();
      const body: ImageOpRequest = {
        op,
        imagePath,
        maskB64:
          def.needsSelection && editor.selection
            ? buildMask(editor.selection, op === "replace-background")
            : null,
        prompt: prompt.trim() || null,
        pad: op === "expand" ? pad : null,
        scale: op === "enlarge" ? scale : null,
      };
      const result = await runOp.mutateAsync({ data: body });
      applyResult(result);
      toast({
        title: `${def.label} applied`,
        description:
          result.units > 0
            ? `This used ${result.units} image generation.`
            : "No image generation was used.",
      });
    } catch (error) {
      toast({
        title: `${def.label} failed`,
        description: apiErrorMessage(error, "The image provider rejected the request."),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollArea className="h-full" data-testid="editor-ai-panel">
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-1">
          {OPS.map((entry) => {
            const Icon = entry.icon;
            return (
              <Button
                key={entry.id}
                type="button"
                size="sm"
                variant={op === entry.id ? "secondary" : "outline"}
                className="h-auto flex-col gap-1 px-2 py-2 text-[11px]"
                onClick={() => setOp(entry.id)}
                data-testid={`editor-ai-op-${entry.id}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {entry.label}
              </Button>
            );
          })}
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">{def.hint}</p>

        {def.needsSelection && !hasSelection && (
          <p className="rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">
            No selection yet. Pick the marquee, lasso or magic wand from the tool rail and mark the area.
          </p>
        )}

        {(def.needsPrompt || op === "expand") && (
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {op === "expand" ? "What is out there? (optional)" : "Describe it"}
            </Label>
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={op === "replace-background" ? "a soft pink studio backdrop" : "a ceramic vase"}
              className="h-7 text-xs"
              data-testid="editor-ai-prompt"
            />
          </div>
        )}

        {op === "expand" && (
          <div className="space-y-2">
            <Label className="text-[11px] text-muted-foreground">Expand by</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["left", "right", "top", "bottom"] as const).map((edge) => (
                <div key={edge} className="flex items-center gap-1">
                  <span className="w-10 text-[11px] capitalize text-muted-foreground">{edge}</span>
                  <Input
                    type="number"
                    min={0}
                    max={2048}
                    value={pad[edge]}
                    onChange={(e) =>
                      setPad((p) => ({ ...p, [edge]: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    className="h-7 text-xs"
                  />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              The provider returns one of three sizes, so the result is the closest shape to what you ask
              for — your existing picture is re-placed inside it, never cropped.
            </p>
          </div>
        )}

        {op === "enlarge" && (
          <div className="flex gap-1">
            {([2, 4] as const).map((factor) => (
              <Button
                key={factor}
                type="button"
                size="sm"
                variant={scale === factor ? "secondary" : "outline"}
                className="h-7 flex-1 text-[11px]"
                onClick={() => setScale(factor)}
              >
                {factor}×
              </Button>
            ))}
          </div>
        )}

        {def.flattens && (
          <p className="rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">
            This flattens the document into a single background layer. Undo restores your layers.
          </p>
        )}

        <Separator />

        <Button
          type="button"
          size="sm"
          className="h-8 w-full text-xs"
          onClick={() => void run()}
          disabled={busy}
          data-testid="editor-ai-run"
        >
          {busy ? <RippleSpinner className="mr-1 h-3.5 w-3.5" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
          {def.units > 0 ? `Run — ${def.units} credit` : "Run — free"}
        </Button>
      </div>
    </ScrollArea>
  );
}
