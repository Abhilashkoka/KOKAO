import type {
  GuidedStoryDraft,
  GuidedStoryPromoOverlaysInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";

export const MAX_PROMO_TEXT_LINES = 3;
export const MAX_PROMO_TEXT_CHARS = 60;

type Position = "top" | "middle" | "bottom";
type Timing = "start" | "whole" | "end";
type Style = "red" | "yellow" | "black" | "white";
type Corner = "bottom_right" | "bottom_left" | "top_right" | "top_left";

export interface PromoTextRow {
  key: string;
  text: string;
  position: Position;
  timing: Timing;
  style: Style;
}

export interface PromoOverlaysValue {
  textOverlays: PromoTextRow[];
  faceBubble: { enabled: boolean; corner: Corner };
}

export const EMPTY_PROMO_OVERLAYS: PromoOverlaysValue = {
  textOverlays: [],
  faceBubble: { enabled: false, corner: "bottom_right" },
};

let rowSeq = 0;
const rowKey = () => `promo-${++rowSeq}`;

const POSITIONS: Array<{ value: Position; label: string }> = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Lower third" },
  { value: "bottom", label: "Bottom" },
];
const TIMINGS: Array<{ value: Timing; label: string }> = [
  { value: "start", label: "First 3 sec" },
  { value: "whole", label: "Whole video" },
  { value: "end", label: "Last 4 sec" },
];
const STYLES: Array<{ value: Style; label: string; swatch: string }> = [
  { value: "red", label: "Red", swatch: "#E53935" },
  { value: "yellow", label: "Yellow", swatch: "#FFD54F" },
  { value: "black", label: "Black", swatch: "#111111" },
  { value: "white", label: "White", swatch: "#FFFFFF" },
];
const CORNERS: Array<{ value: Corner; label: string }> = [
  { value: "bottom_right", label: "Bottom right" },
  { value: "bottom_left", label: "Bottom left" },
  { value: "top_right", label: "Top right" },
  { value: "top_left", label: "Top left" },
];

/** Sensible defaults for each new line: hook first, then offer, then shop name. */
const ROW_DEFAULTS: Array<Omit<PromoTextRow, "key" | "text">> = [
  { position: "top", timing: "start", style: "red" },
  { position: "middle", timing: "whole", style: "yellow" },
  { position: "bottom", timing: "end", style: "black" },
];

export function promoOverlaysFromDraft(draft: GuidedStoryDraft): PromoOverlaysValue {
  const saved = draft.setup?.promoOverlays;
  if (!saved) return EMPTY_PROMO_OVERLAYS;
  return {
    textOverlays: (saved.textOverlays ?? []).map((row) => ({
      key: rowKey(),
      text: row.text,
      position: row.position as Position,
      timing: row.timing as Timing,
      style: row.style as Style,
    })),
    faceBubble: {
      enabled: saved.faceBubble?.enabled === true,
      corner: (saved.faceBubble?.corner as Corner | undefined) ?? "bottom_right",
    },
  };
}

/** Payload for the setup request; null clears it on the server. */
export function promoOverlaysInput(value: PromoOverlaysValue): GuidedStoryPromoOverlaysInput | null {
  const textOverlays = value.textOverlays
    .map((row) => ({ ...row, text: row.text.replace(/\s+/g, " ").trim() }))
    .filter((row) => row.text.length > 0)
    .map(({ text, position, timing, style }) => ({ text, position, timing, style }));
  const faceBubble = value.faceBubble.enabled ? { enabled: true, corner: value.faceBubble.corner } : null;
  if (!textOverlays.length && !faceBubble) return null;
  return { version: 1, textOverlays, faceBubble };
}

export function promoOverlaysProblem(value: PromoOverlaysValue): string | null {
  const tooLong = value.textOverlays.find((row) => [...row.text.trim()].length > MAX_PROMO_TEXT_CHARS);
  return tooLong ? `Keep each on-screen text line to ${MAX_PROMO_TEXT_CHARS} characters.` : null;
}

export function GuidedPromoOverlaysEditor({
  value,
  onChange,
  hasFootage,
}: {
  value: PromoOverlaysValue;
  onChange: (next: PromoOverlaysValue) => void;
  /** Whether any upload is used as footage; the bubble only shows over footage. */
  hasFootage: boolean;
}) {
  const rows = value.textOverlays;
  const setRow = (key: string, patch: Partial<PromoTextRow>) =>
    onChange({ ...value, textOverlays: rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  const addRow = () => {
    if (rows.length >= MAX_PROMO_TEXT_LINES) return;
    onChange({
      ...value,
      textOverlays: [...rows, { key: rowKey(), text: "", ...ROW_DEFAULTS[rows.length]! }],
    });
  };
  const open = rows.length > 0 || value.faceBubble.enabled;

  return (
    <details className="rounded-lg border p-3" open={open} data-testid="section-guided-promo-overlays">
      <summary className="cursor-pointer text-sm font-medium">
        Shop promo extras <span className="font-normal text-muted-foreground">(optional)</span>
      </summary>
      <div className="mt-3 space-y-5">
        <div className="space-y-2">
          <Label>On-screen text</Label>
          <p className="text-xs text-muted-foreground">
            Bold text on the video — a hook, your offer or price, your shop name. Telugu, Hindi and Tamil work too.
          </p>
          {rows.map((row, index) => {
            const length = [...row.text].length;
            return (
              <div key={row.key} className="space-y-2 rounded-md bg-muted/40 p-2.5" data-testid={`row-promo-text-${index}`}>
                <div className="flex items-center gap-2">
                  <Input
                    value={row.text}
                    maxLength={MAX_PROMO_TEXT_CHARS * 2}
                    onChange={(event) => setRow(row.key, { text: event.target.value })}
                    placeholder={["e.g. 30K ka kaam ₹999 mein", "e.g. కొత్త కలెక్షన్ ₹999 మాత్రమే", "e.g. Sri Lakshmi Silks · Vijayawada"][index]}
                    aria-label={`On-screen text ${index + 1}`}
                    data-testid={`input-promo-text-${index}`}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove on-screen text ${index + 1}`}
                    onClick={() => onChange({ ...value, textOverlays: rows.filter((item) => item.key !== row.key) })}
                    data-testid={`button-remove-promo-text-${index}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Select value={row.position} onValueChange={(position) => setRow(row.key, { position: position as Position })}>
                    <SelectTrigger aria-label="Position" data-testid={`select-promo-position-${index}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {POSITIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={row.timing} onValueChange={(timing) => setRow(row.key, { timing: timing as Timing })}>
                    <SelectTrigger aria-label="When" data-testid={`select-promo-timing-${index}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIMINGS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={row.style} onValueChange={(style) => setRow(row.key, { style: style as Style })}>
                    <SelectTrigger aria-label="Colour" data-testid={`select-promo-style-${index}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STYLES.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          <span className="inline-flex items-center gap-2">
                            <span className="h-3 w-3 rounded-sm border" style={{ background: item.swatch }} />
                            {item.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {length > MAX_PROMO_TEXT_CHARS && (
                  <p className="text-xs text-destructive">{length}/{MAX_PROMO_TEXT_CHARS} characters — shorten this line.</p>
                )}
              </div>
            );
          })}
          {rows.length < MAX_PROMO_TEXT_LINES && (
            <Button type="button" size="sm" variant="outline" onClick={addRow} data-testid="button-add-promo-text">
              <Plus className="mr-1 h-4 w-4" /> Add text
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="guided-face-bubble">Face bubble</Label>
              <p className="text-xs text-muted-foreground">
                Your presenter talks from a round bubble in the corner while your uploaded clips play — screen recordings, shop footage.
              </p>
            </div>
            <Switch
              id="guided-face-bubble"
              checked={value.faceBubble.enabled}
              onCheckedChange={(enabled) => onChange({ ...value, faceBubble: { ...value.faceBubble, enabled } })}
              data-testid="switch-guided-face-bubble"
            />
          </div>
          {value.faceBubble.enabled && (
            <>
              <Select
                value={value.faceBubble.corner}
                onValueChange={(corner) => onChange({ ...value, faceBubble: { ...value.faceBubble, corner: corner as Corner } })}
              >
                <SelectTrigger aria-label="Bubble corner" className="w-48" data-testid="select-face-bubble-corner"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CORNERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {!hasFootage && (
                <p className="text-xs text-muted-foreground" data-testid="status-face-bubble-needs-footage">
                  Add a video upload marked as footage — the bubble shows over those clips.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </details>
  );
}
