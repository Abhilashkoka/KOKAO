/** Cover Studio vocabulary; layer documents remain editable in the image editor. */
export const COVER_WIDTH = 1080;
export const COVER_HEIGHT = 1350;
export const HEADLINE_MAX_CHARS = 28;
export const KICKER_MAX_CHARS = 24;
export const SUBLINE_MAX_CHARS = 48;
export type CoverLayout = "behind" | "over";
export type CoverPosition = "top" | "bottom";
export type HeadlineStyle = "condensed" | "grotesk";
export type CoverTheme = "auto" | "light" | "dark";
export type CoverAccent = "sparkle" | "arrow" | "none";
export type CoverGrade = "editorial" | "none";
export interface CoverCopy { kicker: string; headline: string; subline: string; }
export interface CoverOptions {
  layout: CoverLayout;
  position: CoverPosition;
  headlineStyle: HeadlineStyle;
  theme: CoverTheme;
  accent: CoverAccent;
  grade: CoverGrade;
  accentColor: string | null;
}
export const DEFAULT_COVER_OPTIONS: CoverOptions = {
  layout: "behind", position: "top", headlineStyle: "condensed",
  theme: "auto", accent: "sparkle", grade: "editorial", accentColor: null,
};
export const MAX_HEADLINE_OCCLUSION = 0.4;
function clean(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}
export function normalizeCoverCopy(raw: Partial<Record<keyof CoverCopy, unknown>>): CoverCopy {
  return {
    kicker: clean(raw.kicker, KICKER_MAX_CHARS),
    headline: clean(raw.headline, HEADLINE_MAX_CHARS),
    subline: clean(raw.subline, SUBLINE_MAX_CHARS),
  };
}
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
export function normalizeCoverOptions(raw: Partial<Record<keyof CoverOptions, unknown>>): CoverOptions {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const d = DEFAULT_COVER_OPTIONS;
  return {
    layout: pick(raw.layout, ["behind", "over"] as const, d.layout),
    position: pick(raw.position, ["top", "bottom"] as const, d.position),
    headlineStyle: pick(raw.headlineStyle, ["condensed", "grotesk"] as const, d.headlineStyle),
    theme: pick(raw.theme, ["auto", "light", "dark"] as const, d.theme),
    accent: pick(raw.accent, ["sparkle", "arrow", "none"] as const, d.accent),
    grade: pick(raw.grade, ["editorial", "none"] as const, d.grade),
    accentColor: isHexColor(raw.accentColor) ? raw.accentColor : null,
  };
}
export interface CoverDocLayer {
  id: string; type: "image"; objectPath: string;
  x: number; y: number; width: number; height: number;
  rotation: number; scaleX: number; scaleY: number;
  opacity?: number; name?: string;
}
export interface CoverLayerDoc { version: 1; basePath: string; layers: CoverDocLayer[]; }