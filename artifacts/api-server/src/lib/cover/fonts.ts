import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundled SIL OFL fonts; explicit files keep Sharp/Pango rendering consistent. */
export interface CoverFont { family: string; file: string; }
export const COVER_FONTS = {
  condensed: { family: "Anton", file: "Anton-Regular.ttf" },
  grotesk: { family: "Inter Tight SemiBold", file: "InterTight-SemiBold.ttf" },
  kicker: { family: "Instrument Serif Italic", file: "InstrumentSerif-Italic.ttf" },
  subline: { family: "Inter Tight", file: "InterTight-Regular.ttf" },
} as const satisfies Record<string, CoverFont>;
let cachedDir: string | null = null;
/** Works both from src/lib/cover and the esbuild bundle in dist. */
export function coverFontsDir(): string {
  if (cachedDir) return cachedDir;
  const override = process.env.COVER_FONTS_DIR;
  if (override && existsSync(join(override, COVER_FONTS.condensed.file))) {
    cachedDir = override;
    return override;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "assets", "fonts");
    if (existsSync(join(candidate, COVER_FONTS.condensed.file))) {
      cachedDir = candidate;
      return candidate;
    }
    dir = resolve(dir, "..");
  }
  throw new Error("Cover fonts not found. Expected artifacts/api-server/assets/fonts (or set COVER_FONTS_DIR).");
}
export function fontPath(font: CoverFont): string { return join(coverFontsDir(), font.file); }