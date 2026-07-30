/**
 * The editor's chrome: tool rail, layers panel, properties panel, history.
 *
 * Presentation only — every panel reads and writes through `EditorApi` and
 * holds no document state of its own. The one piece of judgement in here is
 * what to show: a properties panel that renders every control a layer type
 * could have is a wall, so each section is driven by whether the selected
 * layer can actually use it.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Eye,
  EyeOff,
  FlipHorizontal,
  FlipVertical,
  Folder,
  Image as ImageIcon,
  Layers as LayersIcon,
  Lock,
  Paintbrush,
  Redo2,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Type as TypeIcon,
  Undo2,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ADJUSTMENT_CONTROLS, ADJUSTMENT_PRESETS } from "@/lib/imageEditor/adjustments";
import { BLEND_GROUPS, blendLabel } from "@/lib/imageEditor/blend";
import {
  BASE_LAYER_ID,
  DEFAULT_GLOW,
  DEFAULT_SHADOW,
  DEFAULT_STROKE,
  layerLabel,
  makeAdjustmentLayer,
  makePaintLayer,
  type Adjustments,
  type BlendMode,
  type Layer,
  type LayerFx,
} from "@/lib/imageEditor/doc";
import { TOOLS, type ToolId } from "@/lib/imageEditor/shortcuts";
import { panelLayers, type EditorApi } from "./use-editor";

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

function Section({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
        </button>
        {action}
      </div>
      {open && <div className="space-y-3 px-3 pb-3">{children}</div>}
    </div>
  );
}

function NumberRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        <span className="tabular-nums text-[11px] text-muted-foreground">
          {Number.isInteger(step) ? Math.round(value) : value.toFixed(2)}
          {suffix ?? ""}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <input
        type="color"
        value={value.length === 7 ? value : "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tool rail
 * ------------------------------------------------------------------ */

export function ToolRail({ editor }: { editor: EditorApi }) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-border bg-background py-2">
      {TOOLS.map((tool) => {
        const active = editor.tool === tool.id;
        return (
          <Tooltip key={tool.id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => editor.setTool(tool.id as ToolId)}
                data-testid={`editor-tool-${tool.id}`}
                aria-label={tool.label}
                aria-pressed={active}
              >
                <ToolIcon id={tool.id} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {tool.label} <span className="ml-1 opacity-60">{tool.key}</span>
              <div className="max-w-[180px] text-[11px] opacity-70">{tool.hint}</div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ToolIcon({ id }: { id: string }) {
  const className = "h-4 w-4";
  switch (id) {
    case "text":
      return <TypeIcon className={className} />;
    case "brush":
    case "mask-brush":
      return <Paintbrush className={className} />;
    case "shape":
      return <Square className={className} />;
    case "gradient":
      return <Circle className={className} />;
    case "crop":
      return <Scissors className={className} />;
    case "wand":
      return <Sparkles className={className} />;
    default:
      return <LayersIcon className={className} />;
  }
}

/* ------------------------------------------------------------------ *
 * Layers panel
 * ------------------------------------------------------------------ */

export function LayersPanel({ editor }: { editor: EditorApi }) {
  const rows = useMemo(() => panelLayers(editor.doc), [editor.doc]);

  return (
    <div className="flex h-full flex-col" data-testid="editor-layers-panel">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Layers
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="New paint layer"
          onClick={() => editor.addLayer(makePaintLayer(editor.doc.width, editor.doc.height), "Add paint layer")}
          data-testid="editor-add-paint-layer"
        >
          <Paintbrush className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="New adjustment layer"
          onClick={() => editor.addLayer(makeAdjustmentLayer({ contrast: 10 }), "Add adjustment layer")}
          data-testid="editor-add-adjustment-layer"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="Duplicate"
          onClick={() => editor.runCommand("duplicate")}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="Delete"
          onClick={() => editor.runCommand("delete")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-1">
          {rows.map(({ layer, depth }) => {
            const selected = editor.selectedIds.includes(layer.id);
            return (
              <div
                key={layer.id}
                className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs ${
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
                }`}
                style={{ paddingLeft: 6 + depth * 12 }}
                data-testid={`editor-layer-row-${layer.id}`}
              >
                <button
                  type="button"
                  className="shrink-0 opacity-70 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    editor.patchLayer(layer.id, { visible: !layer.visible }, "Toggle visibility");
                  }}
                  aria-label={layer.visible ? "Hide layer" : "Show layer"}
                >
                  {layer.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>

                <LayerTypeIcon layer={layer} />

                <button
                  type="button"
                  className="flex-1 truncate text-left"
                  onClick={(e) => editor.selectLayer(layer.id, e.shiftKey)}
                >
                  {layer.clipped && <span className="mr-1 opacity-50">↳</span>}
                  {layerLabel(layer)}
                </button>

                {layer.maskPath || editor.raster.hasMask(layer.id) ? (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm border border-foreground/40 bg-gradient-to-br from-white to-black"
                    title="Has a layer mask"
                  />
                ) : null}

                <button
                  type="button"
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    editor.patchLayer(layer.id, { locked: !layer.locked }, "Toggle lock");
                  }}
                  aria-label={layer.locked ? "Unlock layer" : "Lock layer"}
                >
                  {layer.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function LayerTypeIcon({ layer }: { layer: Layer }) {
  const className = "h-3 w-3 shrink-0 opacity-60";
  switch (layer.type) {
    case "group":
      return <Folder className={className} />;
    case "text":
      return <TypeIcon className={className} />;
    case "adjustment":
      return <Sparkles className={className} />;
    case "paint":
      return <Paintbrush className={className} />;
    case "shape":
    case "gradient":
      return <Square className={className} />;
    default:
      return <ImageIcon className={className} />;
  }
}

/* ------------------------------------------------------------------ *
 * Properties panel
 * ------------------------------------------------------------------ */

export function PropertiesPanel({ editor }: { editor: EditorApi }) {
  const layer = editor.selectedLayer;

  if (!layer) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="editor-properties-empty">
        Select a layer to edit its properties, or pick a tool from the left.
      </div>
    );
  }

  const patch = (values: Partial<Layer>, label: string, mergeKey?: string) =>
    editor.patchLayer(layer.id, values, label, mergeKey);

  const setAdjustment = (key: keyof Adjustments, value: number) => {
    const next: Adjustments = { ...(layer.adjustments ?? {}) };
    if (value === 0) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
    patch({ adjustments: Object.keys(next).length > 0 ? next : undefined }, "Adjust", `adj:${layer.id}:${key}`);
  };

  const setFx = (values: Partial<LayerFx>, label: string, mergeKey?: string) => {
    const next: LayerFx = { ...(layer.fx ?? {}), ...values };
    for (const key of Object.keys(next) as Array<keyof LayerFx>) {
      if (next[key] === undefined) delete next[key];
    }
    patch({ fx: Object.keys(next).length > 0 ? next : undefined }, label, mergeKey);
  };

  const canStroke = layer.type === "text" || layer.type === "shape";

  return (
    <ScrollArea className="h-full" data-testid="editor-properties-panel">
      <Section title="Layer">
        <Input
          value={layer.name}
          onChange={(e) => patch({ name: e.target.value }, "Rename layer", `name:${layer.id}`)}
          className="h-7 text-xs"
          data-testid="editor-layer-name"
        />
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Blend mode</Label>
          <Select
            value={layer.blend}
            onValueChange={(value) => patch({ blend: value as BlendMode }, "Change blend mode")}
          >
            <SelectTrigger className="h-7 text-xs" data-testid="editor-blend-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLEND_GROUPS.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectLabel className="text-[11px]">{group.label}</SelectLabel>
                  {group.modes.map((mode) => (
                    <SelectItem key={mode} value={mode} className="text-xs">
                      {blendLabel(mode)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <NumberRow
          label="Opacity"
          value={layer.opacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patch({ opacity: v }, "Change opacity", `opacity:${layer.id}`)}
        />
        <NumberRow
          label="Fill"
          value={layer.fill}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patch({ fill: v }, "Change fill", `fill:${layer.id}`)}
        />
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant={layer.clipped ? "secondary" : "outline"}
            className="h-7 px-2 text-[11px]"
            onClick={() => editor.runCommand("clip-to-below")}
            title="Clip to the layer below"
          >
            Clip
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              editor.raster.maskCanvas(layer.id, editor.doc.width, editor.doc.height);
              editor.bumpRaster();
              editor.setTool("mask-brush");
            }}
            data-testid="editor-add-mask"
          >
            Add mask
          </Button>
          {(editor.raster.hasMask(layer.id) || layer.maskPath) && (
            <>
              <Button
                type="button"
                size="sm"
                variant={layer.maskDisabled ? "secondary" : "outline"}
                className="h-7 px-2 text-[11px]"
                onClick={() => patch({ maskDisabled: !layer.maskDisabled }, "Toggle mask")}
              >
                {layer.maskDisabled ? "Mask off" : "Mask on"}
              </Button>
              {editor.selection && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    if (!editor.selection) return;
                    editor.raster.setMaskFromSelection(
                      layer.id,
                      editor.selection,
                      editor.doc.width,
                      editor.doc.height,
                    );
                    editor.bumpRaster();
                  }}
                >
                  Selection → mask
                </Button>
              )}
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => editor.runCommand("flip-horizontal")}
            title="Flip horizontally"
          >
            <FlipHorizontal className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => editor.runCommand("flip-vertical")}
            title="Flip vertically"
          >
            <FlipVertical className="h-3 w-3" />
          </Button>
        </div>
      </Section>

      <Section title="Transform" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2">
          <NumberRow
            label="X"
            value={layer.x}
            min={-editor.doc.width}
            max={editor.doc.width * 2}
            onChange={(v) => patch({ x: v }, "Move layer", `x:${layer.id}`)}
          />
          <NumberRow
            label="Y"
            value={layer.y}
            min={-editor.doc.height}
            max={editor.doc.height * 2}
            onChange={(v) => patch({ y: v }, "Move layer", `y:${layer.id}`)}
          />
        </div>
        <NumberRow
          label="Rotation"
          value={layer.rotation}
          min={-180}
          max={180}
          onChange={(v) => patch({ rotation: v }, "Rotate layer", `rot:${layer.id}`)}
          suffix="°"
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberRow
            label="Skew X"
            value={layer.skewX}
            min={-2}
            max={2}
            step={0.01}
            onChange={(v) => patch({ skewX: v }, "Skew layer", `skx:${layer.id}`)}
          />
          <NumberRow
            label="Skew Y"
            value={layer.skewY}
            min={-2}
            max={2}
            step={0.01}
            onChange={(v) => patch({ skewY: v }, "Skew layer", `sky:${layer.id}`)}
          />
        </div>
      </Section>

      {layer.type === "text" && (
        <Section title="Text">
          <Input
            value={layer.text}
            onChange={(e) => patch({ text: e.target.value }, "Edit text", `text:${layer.id}`)}
            className="h-7 text-xs"
            data-testid="editor-text-input"
          />
          <NumberRow
            label="Size"
            value={layer.fontSize}
            min={8}
            max={Math.max(200, Math.round(editor.doc.width / 3))}
            onChange={(v) => patch({ fontSize: v }, "Change text size", `fs:${layer.id}`)}
          />
          <NumberRow
            label="Weight"
            value={layer.fontWeight}
            min={100}
            max={900}
            step={100}
            onChange={(v) => patch({ fontWeight: v }, "Change weight")}
          />
          <NumberRow
            label="Line height"
            value={layer.lineHeight}
            min={0.7}
            max={3}
            step={0.05}
            onChange={(v) => patch({ lineHeight: v }, "Change line height", `lh:${layer.id}`)}
          />
          <NumberRow
            label="Letter spacing"
            value={layer.letterSpacing}
            min={-20}
            max={80}
            onChange={(v) => patch({ letterSpacing: v }, "Change tracking", `ls:${layer.id}`)}
          />
          <ColorRow
            label="Colour"
            value={layer.color}
            onChange={(v) => patch({ color: v }, "Change text colour", `col:${layer.id}`)}
          />
          <div className="flex gap-1">
            {(["left", "center", "right"] as const).map((align) => (
              <Button
                key={align}
                type="button"
                size="sm"
                variant={layer.align === align ? "secondary" : "outline"}
                className="h-7 flex-1 px-2 text-[11px] capitalize"
                onClick={() => patch({ align }, "Change alignment")}
              >
                {align}
              </Button>
            ))}
          </div>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={layer.uppercase ? "secondary" : "outline"}
              className="h-7 flex-1 px-2 text-[11px]"
              onClick={() => patch({ uppercase: !layer.uppercase }, "Toggle caps")}
            >
              AA
            </Button>
            <Button
              type="button"
              size="sm"
              variant={layer.underline ? "secondary" : "outline"}
              className="h-7 flex-1 px-2 text-[11px] underline"
              onClick={() => patch({ underline: !layer.underline }, "Toggle underline")}
            >
              U
            </Button>
          </div>
        </Section>
      )}

      {layer.type === "shape" && (
        <Section title="Shape">
          <ColorRow label="Fill" value={layer.color} onChange={(v) => patch({ color: v }, "Change shape colour", `sc:${layer.id}`)} />
          <NumberRow
            label="Corner radius"
            value={layer.cornerRadius}
            min={0}
            max={200}
            onChange={(v) => patch({ cornerRadius: v }, "Change corner radius", `cr:${layer.id}`)}
          />
          {(layer.shape === "star" || layer.shape === "polygon") && (
            <NumberRow
              label="Points"
              value={layer.sides}
              min={3}
              max={24}
              onChange={(v) => patch({ sides: Math.round(v) }, "Change points")}
            />
          )}
        </Section>
      )}

      {layer.type === "gradient" && (
        <Section title="Gradient">
          <ColorRow label="From" value={layer.from} onChange={(v) => patch({ from: v }, "Change gradient")} />
          <ColorRow label="To" value={layer.to} onChange={(v) => patch({ to: v }, "Change gradient")} />
          <NumberRow
            label="Angle"
            value={layer.angle}
            min={-180}
            max={180}
            onChange={(v) => patch({ angle: v }, "Rotate gradient", `ga:${layer.id}`)}
            suffix="°"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 w-full text-[11px]"
            onClick={() => patch({ kind: layer.kind === "linear" ? "radial" : "linear" }, "Change gradient type")}
          >
            {layer.kind === "linear" ? "Make radial" : "Make linear"}
          </Button>
        </Section>
      )}

      <Section title="Adjustments" defaultOpen={layer.type === "adjustment"}>
        <div className="flex flex-wrap gap-1">
          {ADJUSTMENT_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              onClick={() =>
                patch(
                  {
                    adjustments:
                      Object.keys(preset.adjustments).length > 0 ? { ...preset.adjustments } : undefined,
                  },
                  `Preset: ${preset.label}`,
                )
              }
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Separator />
        {ADJUSTMENT_CONTROLS.map((control) => (
          <NumberRow
            key={control.key}
            label={control.label}
            value={(layer.adjustments?.[control.key] as number | undefined) ?? control.identity}
            min={control.min}
            max={control.max}
            step={control.step}
            onChange={(v) => setAdjustment(control.key, v)}
          />
        ))}
        <div className="flex gap-1">
          {(["grayscale", "sepia", "invert"] as const).map((flag) => (
            <Button
              key={flag}
              type="button"
              size="sm"
              variant={layer.adjustments?.[flag] ? "secondary" : "outline"}
              className="h-6 flex-1 px-2 text-[10px] capitalize"
              onClick={() => {
                const next: Adjustments = { ...(layer.adjustments ?? {}) };
                if (next[flag]) delete next[flag];
                else next[flag] = true;
                patch({ adjustments: Object.keys(next).length > 0 ? next : undefined }, "Adjust");
              }}
            >
              {flag}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="Effects" defaultOpen={false}>
        <FxToggle
          label="Drop shadow"
          active={!!layer.fx?.dropShadow}
          onToggle={() =>
            setFx({ dropShadow: layer.fx?.dropShadow ? undefined : { ...DEFAULT_SHADOW } }, "Toggle drop shadow")
          }
        />
        {layer.fx?.dropShadow && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2">
            <ColorRow
              label="Colour"
              value={layer.fx.dropShadow.color}
              onChange={(v) => setFx({ dropShadow: { ...layer.fx!.dropShadow!, color: v } }, "Shadow colour")}
            />
            <NumberRow
              label="Distance"
              value={layer.fx.dropShadow.distance}
              min={0}
              max={200}
              onChange={(v) => setFx({ dropShadow: { ...layer.fx!.dropShadow!, distance: v } }, "Shadow", `sd:${layer.id}`)}
            />
            <NumberRow
              label="Blur"
              value={layer.fx.dropShadow.blur}
              min={0}
              max={200}
              onChange={(v) => setFx({ dropShadow: { ...layer.fx!.dropShadow!, blur: v } }, "Shadow", `sb:${layer.id}`)}
            />
            <NumberRow
              label="Angle"
              value={layer.fx.dropShadow.angle}
              min={-180}
              max={180}
              suffix="°"
              onChange={(v) => setFx({ dropShadow: { ...layer.fx!.dropShadow!, angle: v } }, "Shadow", `sa:${layer.id}`)}
            />
            <NumberRow
              label="Opacity"
              value={layer.fx.dropShadow.opacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setFx({ dropShadow: { ...layer.fx!.dropShadow!, opacity: v } }, "Shadow", `so:${layer.id}`)}
            />
          </div>
        )}

        <FxToggle
          label="Outer glow"
          active={!!layer.fx?.outerGlow}
          onToggle={() =>
            setFx({ outerGlow: layer.fx?.outerGlow ? undefined : { ...DEFAULT_GLOW } }, "Toggle glow")
          }
        />
        {layer.fx?.outerGlow && !layer.fx.dropShadow && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2">
            <ColorRow
              label="Colour"
              value={layer.fx.outerGlow.color}
              onChange={(v) => setFx({ outerGlow: { ...layer.fx!.outerGlow!, color: v } }, "Glow colour")}
            />
            <NumberRow
              label="Blur"
              value={layer.fx.outerGlow.blur}
              min={0}
              max={200}
              onChange={(v) => setFx({ outerGlow: { ...layer.fx!.outerGlow!, blur: v } }, "Glow", `gb:${layer.id}`)}
            />
          </div>
        )}
        {layer.fx?.outerGlow && layer.fx.dropShadow && (
          <p className="rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">
            A layer gets one shadow on the canvas. The drop shadow is winning — turn it off to see the glow.
          </p>
        )}

        <FxToggle
          label="Stroke"
          active={!!layer.fx?.stroke}
          disabled={!canStroke}
          onToggle={() => setFx({ stroke: layer.fx?.stroke ? undefined : { ...DEFAULT_STROKE } }, "Toggle stroke")}
        />
        {!canStroke && (
          <p className="text-[11px] text-muted-foreground">Stroke applies to text and shape layers.</p>
        )}
        {layer.fx?.stroke && canStroke && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2">
            <ColorRow
              label="Colour"
              value={layer.fx.stroke.color}
              onChange={(v) => setFx({ stroke: { ...layer.fx!.stroke!, color: v } }, "Stroke colour")}
            />
            <NumberRow
              label="Width"
              value={layer.fx.stroke.width}
              min={0}
              max={60}
              onChange={(v) => setFx({ stroke: { ...layer.fx!.stroke!, width: v } }, "Stroke", `stw:${layer.id}`)}
            />
          </div>
        )}

        <FxToggle
          label="Colour overlay"
          active={!!layer.fx?.colorOverlay}
          onToggle={() =>
            setFx(
              {
                colorOverlay: layer.fx?.colorOverlay
                  ? undefined
                  : { color: "#ffd6e7", opacity: 0.5, blend: "normal" },
              },
              "Toggle colour overlay",
            )
          }
        />
        {layer.fx?.colorOverlay && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2">
            <ColorRow
              label="Colour"
              value={layer.fx.colorOverlay.color}
              onChange={(v) => setFx({ colorOverlay: { ...layer.fx!.colorOverlay!, color: v } }, "Overlay colour")}
            />
            <NumberRow
              label="Opacity"
              value={layer.fx.colorOverlay.opacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setFx({ colorOverlay: { ...layer.fx!.colorOverlay!, opacity: v } }, "Overlay", `ov:${layer.id}`)}
            />
          </div>
        )}

        <FxToggle
          label="Gradient overlay"
          active={!!layer.fx?.gradientOverlay}
          onToggle={() =>
            setFx(
              {
                gradientOverlay: layer.fx?.gradientOverlay
                  ? undefined
                  : { from: "#ffd6e7", to: "#c9e4f5", angle: 90, opacity: 0.6 },
              },
              "Toggle gradient overlay",
            )
          }
        />
        {layer.fx?.gradientOverlay && (
          <div className="space-y-2 rounded-md bg-muted/40 p-2">
            <ColorRow
              label="From"
              value={layer.fx.gradientOverlay.from}
              onChange={(v) => setFx({ gradientOverlay: { ...layer.fx!.gradientOverlay!, from: v } }, "Overlay")}
            />
            <ColorRow
              label="To"
              value={layer.fx.gradientOverlay.to}
              onChange={(v) => setFx({ gradientOverlay: { ...layer.fx!.gradientOverlay!, to: v } }, "Overlay")}
            />
            <NumberRow
              label="Angle"
              value={layer.fx.gradientOverlay.angle}
              min={-180}
              max={180}
              suffix="°"
              onChange={(v) => setFx({ gradientOverlay: { ...layer.fx!.gradientOverlay!, angle: v } }, "Overlay", `goa:${layer.id}`)}
            />
          </div>
        )}
      </Section>

      {layer.id === BASE_LAYER_ID && (
        <div className="px-3 pb-3 text-[11px] text-muted-foreground">
          This is the original image. Deleting it hides it instead, so the document can always be recovered.
        </div>
      )}
    </ScrollArea>
  );
}

function FxToggle({
  label,
  active,
  onToggle,
  disabled,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors ${
        disabled ? "opacity-40" : "hover:bg-muted/60"
      }`}
    >
      <span>{label}</span>
      <span
        className={`h-3 w-3 rounded-full border ${active ? "border-primary bg-primary" : "border-border"}`}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * History panel
 * ------------------------------------------------------------------ */

export function HistoryPanel({ editor }: { editor: EditorApi }) {
  return (
    <div className="flex h-full flex-col" data-testid="editor-history-panel">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          History
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={!editor.canUndo}
          onClick={() => editor.runCommand("undo")}
          title="Undo"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={!editor.canRedo}
          onClick={() => editor.runCommand("redo")}
          title="Redo"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-1">
          {editor.timeline.map((entry) => (
            <button
              key={entry.index}
              type="button"
              onClick={() => editor.jumpToHistoryIndex(entry.index)}
              className={`block w-full truncate rounded px-2 py-1 text-left text-[11px] ${
                entry.current ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
