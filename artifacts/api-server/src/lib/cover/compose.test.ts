import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { prepareCoverCanvas, typesetCover, DARK_INK, LIGHT_INK } from "./compose";
import { applyEditorialGrade, EDITORIAL_VIDEO_FILTER } from "./grade";
import { splitTopicIntoCopy } from "./copy";
import { padForProvider } from "./matte";
import { COVER_HEIGHT, COVER_WIDTH, DEFAULT_COVER_OPTIONS, normalizeCoverCopy, normalizeCoverOptions, type CoverOptions } from "./types";
const SW = 1024, SH = 1536;
async function scene(opts: { bg: string; person: string; headY: number; headR: number }) {
  const { bg, person, headY, headR } = opts;
  const shapes = (fill: string) => `<circle cx="${SW / 2}" cy="${headY}" r="${headR}" fill="${fill}"/>
    <rect x="${SW / 2 - headR * 2.2}" y="${headY + headR * 0.9}" width="${headR * 4.4}" height="${SH}" rx="${headR}" fill="${fill}"/>`;
  const image = (background: string, fill: string) => sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}"><rect width="100%" height="100%" fill="${background}"/>${shapes(fill)}</svg>`));
  return { photo: await image(bg, person).png().toBuffer(), matte: await image("#000", "#fff").greyscale().png().toBuffer() };
}
const copy = { kicker: "My", headline: "Skin Routine", subline: "what a dermatologist uses" };
const opts = (o: Partial<CoverOptions> = {}): CoverOptions => ({ ...DEFAULT_COVER_OPTIONS, ...o });
describe("prepareCoverCanvas", () => {
  it("crops to 1080x1350 and registers the cutout", async () => {
    const { photo, matte } = await scene({ bg: "#e8e4dc", person: "#3a2a22", headY: 520, headR: 120 });
    const canvas = await prepareCoverCanvas({ source: photo, matte, options: opts() });
    expect(await sharp(canvas.base).metadata()).toMatchObject({ width: COVER_WIDTH, height: COVER_HEIGHT });
    expect(await sharp(canvas.subject!).metadata()).toMatchObject({ width: COVER_WIDTH, height: COVER_HEIGHT, hasAlpha: true });
  });
  it("places the head about a sixth down for a top headline", async () => {
    const { photo, matte } = await scene({ bg: "#e8e4dc", person: "#3a2a22", headY: 400, headR: 110 });
    const canvas = await prepareCoverCanvas({ source: photo, matte, options: opts({ grade: "none" }) });
    const alpha = await sharp(canvas.subject!).extractChannel(3).png().toBuffer();
    const { info } = await sharp(alpha).threshold(128).trim({ background: "#000000", threshold: 10 }).toBuffer({ resolveWithObject: true });
    expect(-(info.trimOffsetTop ?? 0) / COVER_HEIGHT).toBeGreaterThan(0.12);
    expect(-(info.trimOffsetTop ?? 0) / COVER_HEIGHT).toBeLessThan(0.22);
  });
  it("discards an empty matte", async () => {
    const { photo } = await scene({ bg: "#e8e4dc", person: "#3a2a22", headY: 520, headR: 120 });
    const empty = await sharp({ create: { width: SW, height: SH, channels: 3, background: "#000" } }).greyscale().png().toBuffer();
    expect((await prepareCoverCanvas({ source: photo, matte: empty, options: opts() })).subject).toBeNull();
  });
});
describe("typesetCover", () => {
  it("stacks headline behind subject with supporting type above", async () => {
    const { photo, matte } = await scene({ bg: "#2b2f36", person: "#c9a48a", headY: 760, headR: 110 });
    const canvas = await prepareCoverCanvas({ source: photo, matte, options: opts() });
    const cover = await typesetCover({ canvas, copy, options: opts() });
    expect(cover.layout).toBe("behind"); expect(cover.notice).toBeNull();
    expect(cover.blocks.map(b => b.id)).toEqual(["headline", "subject", "kicker", "subline", "accent"]);
    expect(await sharp(cover.flat).metadata()).toMatchObject({ width: COVER_WIDTH, height: COVER_HEIGHT });
  });
  it("picks white type on dark photos and ink on light ones", async () => {
    for (const [bg, expected] of [["#1d1f24", LIGHT_INK], ["#f4f1ea", DARK_INK]]) {
      const { photo, matte } = await scene({ bg, person: "#3a2a22", headY: 760, headR: 110 });
      const canvas = await prepareCoverCanvas({ source: photo, matte, options: opts() });
      expect((await typesetCover({ canvas, copy, options: opts() })).textColor).toBe(expected);
    }
  });
  it("falls back when the subject hides too much headline", async () => {
    const { photo, matte } = await scene({ bg: "#2b2f36", person: "#c9a48a", headY: 420, headR: 420 });
    const canvas = await prepareCoverCanvas({ source: photo, matte, options: opts() });
    const cover = await typesetCover({ canvas, copy, options: opts() });
    expect(cover.layout).toBe("over"); expect(cover.notice).toMatch(/hide too much/);
    expect(cover.blocks.some(b => b.id === "subject")).toBe(false);
  });
  it("explains missing mattes and refuses empty headlines", async () => {
    const { photo } = await scene({ bg: "#2b2f36", person: "#c9a48a", headY: 760, headR: 110 });
    const canvas = await prepareCoverCanvas({ source: photo, matte: null, options: opts() });
    const cover = await typesetCover({ canvas, copy, options: opts() });
    expect(cover.layout).toBe("over"); expect(cover.notice).toMatch(/Couldn't separate/);
    await expect(typesetCover({ canvas, copy: { kicker: "", headline: " ", subline: "" }, options: opts() })).rejects.toThrow(/headline/);
  });
  it("keeps every block inside the bottom-position canvas", async () => {
    const { photo, matte } = await scene({ bg: "#2b2f36", person: "#c9a48a", headY: 760, headR: 110 });
    const canvas = await prepareCoverCanvas({ source: photo, matte, options: opts({ position: "bottom" }) });
    for (const accent of ["sparkle", "arrow", "none"] as const) {
      const cover = await typesetCover({ canvas, copy: { kicker: "Let", headline: "AI", subline: "find your next patient" },
        options: opts({ position: "bottom", accent, headlineStyle: "grotesk" }) });
      for (const b of cover.blocks) {
        expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(COVER_WIDTH); expect(b.y + b.height).toBeLessThanOrEqual(COVER_HEIGHT);
      }
    }
  });
});
describe("grade and copy", () => {
  it("desaturates and lifts black levels at the same size", async () => {
    const candy = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0040" } }).png().toBuffer();
    const graded = await applyEditorialGrade(candy);
    const before = await sharp(candy).stats(), after = await sharp(graded).stats();
    expect(await sharp(graded).metadata()).toMatchObject({ width: 64, height: 64 });
    expect(after.channels[0]!.mean).toBeLessThan(before.channels[0]!.mean);
    expect(after.channels[1]!.mean).toBeGreaterThan(before.channels[1]!.mean + 5);
    expect(EDITORIAL_VIDEO_FILTER).toMatch(/eq=contrast=0\.92:saturation=0\.8/);
    expect(EDITORIAL_VIDEO_FILTER).toMatch(/colorchannelmixer=/);
    expect(EDITORIAL_VIDEO_FILTER).toMatch(/noise=alls=\d+:allf=t/);
  });
  it("splits topics and validates options and copy", () => {
    expect(splitTopicIntoCopy("The art of saying no as a founder")).toMatchObject({ kicker: "The", headline: "Art" });
    expect(splitTopicIntoCopy("skin routine for oily skin").headline).toBe("Skin Routine");
    expect(splitTopicIntoCopy("")).toEqual({ kicker: "", headline: "", subline: "" });
    expect(normalizeCoverCopy({ kicker: "x".repeat(60), headline: "  Big   Idea ", subline: 7 }))
      .toEqual({ kicker: "x".repeat(24), headline: "Big Idea", subline: "" });
    expect(normalizeCoverOptions({ layout: "sideways", accentColor: "red", theme: "dark" }))
      .toMatchObject({ layout: "behind", theme: "dark", accentColor: null });
    expect(normalizeCoverOptions({ accentColor: "#6D42F0" }).accentColor).toBe("#6D42F0");
  });
  it("pads, never crops, to the nearest provider aspect", () => {
    expect(padForProvider(1080, 1350)).toEqual({ canvas: { width: 1080, height: 1620 }, pad: { left: 0, top: 135 } });
    expect(padForProvider(1000, 1000).canvas).toEqual({ width: 1000, height: 1000 });
  });
});