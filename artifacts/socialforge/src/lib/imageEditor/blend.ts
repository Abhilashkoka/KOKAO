/**
 * Blend-mode presentation.
 *
 * The mapping itself lives in `doc.ts` next to the type it belongs to; this
 * module is the human-facing half — labels and menu grouping — so the
 * properties panel does not hand-write a 17-entry list and drift from the type.
 */

import { BLEND_MODES, NATIVE_BLEND, type BlendMode } from "./doc";

export function compositeOperationFor(mode: BlendMode): GlobalCompositeOperation {
  return NATIVE_BLEND[mode] ?? "source-over";
}

const LABELS: Partial<Record<BlendMode, string>> = {
  "color-burn": "Color Burn",
  "color-dodge": "Color Dodge",
  "linear-dodge": "Linear Dodge (Add)",
  "soft-light": "Soft Light",
  "hard-light": "Hard Light",
};

export function blendLabel(mode: BlendMode): string {
  return (
    LABELS[mode] ??
    mode
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
  );
}

/**
 * Menu grouping, matching the separators Photoshop uses. Rendered as option
 * groups so the list reads as four short families rather than one long scroll.
 */
export const BLEND_GROUPS: Array<{ label: string; modes: BlendMode[] }> = [
  { label: "Normal", modes: ["normal"] },
  { label: "Darken", modes: ["darken", "multiply", "color-burn"] },
  { label: "Lighten", modes: ["lighten", "screen", "color-dodge", "linear-dodge"] },
  { label: "Contrast", modes: ["overlay", "soft-light", "hard-light"] },
  { label: "Inversion", modes: ["difference", "exclusion"] },
  { label: "Component", modes: ["hue", "saturation", "color", "luminosity"] },
];

/** Sanity net: every supported mode must appear in exactly one menu group. */
export function allBlendModesGrouped(): boolean {
  const grouped = BLEND_GROUPS.flatMap((g) => g.modes);
  return (
    grouped.length === BLEND_MODES.length &&
    BLEND_MODES.every((m) => grouped.filter((g) => g === m).length === 1)
  );
}
