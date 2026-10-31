import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GuidedStoryPromoOverlays,
  GuidedStoryTextOverlay,
} from "@workspace/db";
import { encodeBudgetMs, probeDurationSec, runFfmpeg } from "./slideshow";
import { logger } from "../logger";

/**
 * Shop-promo finishing: bold on-screen text (hook, offer, shop name) burned
 * into a finished video.
 *
 * Text goes through libass (the `ass` filter), never drawtext: drawtext
 * has no complex-script shaping, so Telugu/Tamil conjuncts break. Fonts come
 * from the bundled assets/fonts directory via `fontsdir`, so the render does
 * not depend on what the host has installed.
 */

export const MAX_TEXT_OVERLAYS = 3;
export const MAX_TEXT_OVERLAY_CHARS = 60;
const START_SECONDS = 3;
const END_SECONDS = 4;

const POSITIONS = ["top", "middle", "bottom"] as const;
const TIMINGS = ["start", "whole", "end"] as const;
const STYLES = ["red", "yellow", "black", "white"] as const;
const CORNERS = ["bottom_right", "bottom_left", "top_right", "top_left"] as const;

export class PromoOverlaysInputError extends Error {}

/** Validate and normalise user input. `undefined` keeps the previous value. */
export function normalizePromoOverlays(
  input: unknown,
  previous: GuidedStoryPromoOverlays | null | undefined,
): GuidedStoryPromoOverlays | null {
  if (input === undefined) return previous ?? null;
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new PromoOverlaysInputError("On-screen text and face bubble settings are invalid.");
  }
  const raw = input as { textOverlays?: unknown; faceBubble?: unknown };
  const textOverlays: GuidedStoryTextOverlay[] = [];
  const items = raw.textOverlays ?? [];
  if (!Array.isArray(items) || items.length > MAX_TEXT_OVERLAYS) {
    throw new PromoOverlaysInputError(`Add up to ${MAX_TEXT_OVERLAYS} on-screen text lines.`);
  }
  for (const item of items) {
    const row = (item ?? {}) as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    if ([...text].length > MAX_TEXT_OVERLAY_CHARS) {
      throw new PromoOverlaysInputError(`Keep each on-screen text line to ${MAX_TEXT_OVERLAY_CHARS} characters.`);
    }
    const position = POSITIONS.includes(row.position as never) ? (row.position as GuidedStoryTextOverlay["position"]) : "top";
    const timing = TIMINGS.includes(row.timing as never) ? (row.timing as GuidedStoryTextOverlay["timing"]) : "start";
    const style = STYLES.includes(row.style as never) ? (row.style as GuidedStoryTextOverlay["style"]) : "red";
    textOverlays.push({ text, position, timing, style });
  }
  let faceBubble: GuidedStoryPromoOverlays["faceBubble"] = null;
  if (raw.faceBubble && typeof raw.faceBubble === "object") {
    const bubble = raw.faceBubble as Record<string, unknown>;
    if (bubble.enabled === true) {
      faceBubble = {
        enabled: true,
        corner: CORNERS.includes(bubble.corner as never)
          ? (bubble.corner as NonNullable<GuidedStoryPromoOverlays["faceBubble"]>["corner"])
          : "bottom_right",
      };
    }
  }
  if (!textOverlays.length && !faceBubble) return null;
  return { version: 1, textOverlays, faceBubble };
}

export function faceBubbleEnabled(overlays: GuidedStoryPromoOverlays | null | undefined): boolean {
  return overlays?.faceBubble?.enabled === true;
}

/* ------------------------------------------------------------------ *
 * On-screen text
 * ------------------------------------------------------------------ */

/** Bundled font family for the text's script. Latin gets the bold display face. */
export function overlayFontFamily(text: string): string {
  if (/\p{Script=Telugu}/u.test(text)) return "Noto Sans Telugu";
  if (/\p{Script=Tamil}/u.test(text)) return "Noto Sans Tamil";
  if (/\p{Script=Devanagari}/u.test(text)) return "Noto Sans Devanagari";
  return "Anton";
}

function isIndic(family: string): boolean {
  return family.startsWith("Noto Sans");
}

/** ASS colour: &HAABBGGRR, alpha 00 = opaque. */
function assColour(hex: string, alpha = 0): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}

const PALETTE: Record<GuidedStoryTextOverlay["style"], { text: string; box: string; boxAlpha: number }> = {
  red: { text: "#FFFFFF", box: "#E53935", boxAlpha: 0 },
  yellow: { text: "#1A1A1A", box: "#FFD54F", boxAlpha: 0 },
  black: { text: "#FFFFFF", box: "#111111", boxAlpha: 0x30 },
  white: { text: "#1A1A1A", box: "#FFFFFF", boxAlpha: 0 },
};

// "middle" is the lower third: bottom-anchored about a third of the way up,
// so it sits below the presenter's face rather than across it.
const ALIGNMENT: Record<GuidedStoryTextOverlay["position"], number> = { top: 8, middle: 2, bottom: 2 };
const MARGIN_V: Record<GuidedStoryTextOverlay["position"], number> = { top: 0.11, middle: 0.31, bottom: 0.19 };

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function assText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\n/g, " ");
}

/** When an overlay is on screen, in seconds of the finished video. */
export function overlayWindow(
  timing: GuidedStoryTextOverlay["timing"],
  durationSec: number,
): { startSec: number; endSec: number } {
  if (timing === "start") return { startSec: 0, endSec: Math.min(START_SECONDS, durationSec) };
  if (timing === "end") return { startSec: Math.max(0, durationSec - END_SECONDS), endSec: durationSec };
  return { startSec: 0, endSec: durationSec };
}

/** Build the ASS script for a set of overlays. Exported for tests. */
export function buildPromoTextAss(params: {
  overlays: readonly GuidedStoryTextOverlay[];
  width: number;
  height: number;
  durationSec: number;
}): string {
  const { width: W, height: H } = params;
  const shortEdge = Math.min(W, H);
  const styles: string[] = [];
  const events: string[] = [];
  params.overlays.forEach((overlay, index) => {
    const family = overlayFontFamily(overlay.text);
    const palette = PALETTE[overlay.style];
    // Anton is a condensed display face; Indic faces run wider, so smaller.
    const fontSize = Math.round(shortEdge * (isIndic(family) ? 0.062 : 0.08));
    const pad = Math.round(fontSize * 0.28);
    // Keep clear of platform UI: top bar, and the caption/buttons at the bottom.
    const marginV = Math.round(H * MARGIN_V[overlay.position]);
    const marginH = Math.round(W * 0.09);
    styles.push(
      [
        `Style: o${index}`,
        family,
        fontSize,
        assColour(palette.text),
        assColour(palette.text),
        assColour(palette.box, palette.boxAlpha),
        assColour(palette.box, palette.boxAlpha),
        // Never synthesise bold for Indic: faux bold smears conjuncts.
        isIndic(family) ? 0 : -1,
        0, 0, 0, 100, 100,
        // No letter spacing — it pulls conjunct ligatures apart.
        0, 0,
        3, // BorderStyle 3: opaque box behind the text
        pad,
        0,
        ALIGNMENT[overlay.position],
        marginH,
        marginH,
        marginV,
        1,
      ].join(","),
    );
    const window = overlayWindow(overlay.timing, params.durationSec);
    if (window.endSec - window.startSec < 0.2) return;
    const fade = overlay.timing === "whole" ? "" : "{\\fad(200,200)}";
    events.push(`Dialogue: 0,${assTime(window.startSec)},${assTime(window.endSec)},o${index},,0,0,0,,${fade}${assText(overlay.text)}`);
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** The bundled fonts directory, across the workspace layouts the server runs in. */
export async function bundledFontsDir(): Promise<string | null> {
  const roots = [
    join(process.cwd(), "assets", "fonts"),
    join(process.cwd(), "artifacts", "api-server", "assets", "fonts"),
  ];
  for (const root of roots) {
    try {
      await access(join(root, "NotoSansTelugu.ttf"));
      return root;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

/**
 * Burn on-screen text into a finished video. Fail-soft: any error returns the
 * original video, because a text hiccup must never fail a paid render.
 */
export async function applyPromoTextOverlays(
  video: Buffer,
  overlays: readonly GuidedStoryTextOverlay[],
  frame: { width: number; height: number },
): Promise<Buffer> {
  if (!overlays.length) return video;
  const fontsDir = await bundledFontsDir();
  if (!fontsDir) {
    logger.warn("Bundled fonts not found; skipping on-screen text");
    return video;
  }
  const dir = await mkdtemp(join(tmpdir(), "kokao-promo-text-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    const durationSec = await probeDurationSec("in.mp4", dir);
    if (!durationSec) return video;
    await writeFile(
      join(dir, "text.ass"),
      buildPromoTextAss({ overlays, width: frame.width, height: frame.height, durationSec }),
      "utf8",
    );
    // fontsdir sits inside a filtergraph string: escape the characters that
    // filtergraph parsing treats specially.
    const escapedFonts = fontsDir.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    await runFfmpeg(
      [
        "-y",
        "-i", "in.mp4",
        // shaping=complex is load-bearing: libass's default can fall back to
        // simple shaping, which renders Telugu viramas instead of conjuncts.
        "-vf", `ass=text.ass:fontsdir=${escapedFonts}:shaping=complex`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "out.mp4",
      ],
      dir,
      encodeBudgetMs(durationSec),
    );
    const out = await readFile(join(dir, "out.mp4"));
    return out.length > 0 ? out : video;
  } catch (error) {
    logger.warn({ err: error }, "On-screen text overlay failed; delivering the video without it");
    return video;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
