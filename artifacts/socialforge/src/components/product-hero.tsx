import type { GuidedStoryShot } from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ShotType = GuidedStoryShot["type"];
type Camera = GuidedStoryShot["camera"];
type Lighting = GuidedStoryShot["lighting"];

export const SHOT_TYPE_OPTIONS: Array<[ShotType, string]> = [
  ["macro_closeup", "Macro close-up"],
  ["hero_shot", "Hero shot"],
  ["in_hand", "In hand"],
  ["in_use", "In use"],
  ["texture", "Texture"],
  ["product_only", "Product only"],
  ["character_with_product", "Character + product"],
  ["story_wide", "Story wide"],
];
export const CAMERA_OPTIONS: Array<[Camera, string]> = [
  ["orbit", "Orbit 360°"],
  ["push_in", "Push in"],
  ["pull_out", "Pull out"],
  ["slide", "Slide"],
  ["top_down", "Top down"],
  ["tilt_reveal", "Tilt reveal"],
  ["rack_focus", "Rack focus"],
  ["static", "Static"],
];
export const LIGHTING_OPTIONS: Array<[Lighting, string]> = [
  ["studio_key", "Studio key"],
  ["rim_light", "Rim light"],
  ["backlit_glow", "Backlit glow"],
  ["window_light", "Window light"],
  ["light_sweep", "Light sweep"],
  ["golden_hour", "Golden hour"],
];
const VIEW_LABELS: Record<string, string> = {
  front: "Front",
  back: "Back",
  side: "Side",
  top: "Top",
  label: "Label",
  detail: "Detail",
  in_use: "In use",
  packaging: "Packaging",
};

/** Script review: how much of the video shows the product, against the target. */
export function ProductScreenTimeMeter({
  screenTime,
}: {
  screenTime: { seconds: number; share: number; runtime: number; target: number } | null;
}) {
  if (!screenTime) return null;
  const percent = Math.round(screenTime.share * 100);
  const target = Math.round(screenTime.target * 100);
  const ok = screenTime.share + 0.05 >= screenTime.target;
  return (
    <div className={`space-y-1.5 rounded-md border p-3 ${ok ? "bg-muted/30" : "border-amber-500/50 bg-amber-50/60 dark:bg-amber-950/20"}`} data-testid="product-screen-time">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Product on screen: {percent}%</span>
        <span className="text-xs text-muted-foreground">target {target}% · {screenTime.seconds}s of {screenTime.runtime}s</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${ok ? "bg-primary" : "bg-amber-500"}`} style={{ width: `${Math.min(100, percent)}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-foreground/60" style={{ left: `${target}%` }} />
      </div>
      {!ok && <p className="text-xs text-muted-foreground">Tag more scenes with the product, change their shots below, or regenerate the script.</p>}
    </div>
  );
}

function ShotSelect<T extends string>({ value, options, onChange, testId, label }: { value: T; options: Array<[T, string]>; onChange: (next: T) => void; testId: string; label: string }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger className="h-7 w-auto gap-1 text-xs" aria-label={label} data-testid={testId}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => <SelectItem key={id} value={id}>{text}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Script review: shot type, camera, lighting and product angle for one scene. */
export function SceneShotPicker({
  shot,
  views,
  onChange,
  sceneLabel,
}: {
  shot: GuidedStoryShot | null;
  views: string[];
  onChange: (next: GuidedStoryShot) => void;
  sceneLabel: string;
}) {
  const current: GuidedStoryShot = shot ?? { type: "character_with_product", camera: "push_in", lighting: "studio_key", angle: null };
  const angleOptions: Array<[string, string]> = [["any", "Any angle"], ...views.map((view): [string, string] => [view, VIEW_LABELS[view] ?? view])];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`scene-shot-${sceneLabel}`}>
      <span className="text-xs font-medium text-muted-foreground">Shot:</span>
      <ShotSelect label="Shot type" value={current.type} options={SHOT_TYPE_OPTIONS} onChange={(type) => onChange({ ...current, type })} testId={`select-shot-type-${sceneLabel}`} />
      <ShotSelect label="Camera" value={current.camera} options={CAMERA_OPTIONS} onChange={(camera) => onChange({ ...current, camera })} testId={`select-shot-camera-${sceneLabel}`} />
      <ShotSelect label="Lighting" value={current.lighting} options={LIGHTING_OPTIONS} onChange={(lighting) => onChange({ ...current, lighting })} testId={`select-shot-lighting-${sceneLabel}`} />
      <ShotSelect
        label="Product angle"
        value={current.angle && views.includes(current.angle) ? current.angle : "any"}
        options={angleOptions}
        onChange={(angle) => onChange({ ...current, angle: angle === "any" ? null : (angle as GuidedStoryShot["angle"]) })}
        testId={`select-shot-angle-${sceneLabel}`}
      />
    </div>
  );
}
