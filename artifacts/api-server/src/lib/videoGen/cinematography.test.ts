import { describe, it, expect } from "vitest";
import {
  CAMERAS,
  LENSES,
  FOCAL_LENGTHS,
  APERTURES,
  cinematographyClause,
  isValidCinematography,
  normalizeCinematography,
} from "./cinematography";

describe("cinematography catalog", () => {
  it("has unique ids per axis", () => {
    for (const axis of [CAMERAS, LENSES, APERTURES]) {
      const ids = axis.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const mm = FOCAL_LENGTHS.map((f) => f.mm);
    expect(new Set(mm).size).toBe(mm.length);
  });

  it("gives every option a real prompt fragment", () => {
    for (const option of [...CAMERAS, ...LENSES, ...APERTURES]) {
      expect(option.prompt.trim().length, option.id).toBeGreaterThan(20);
    }
    for (const focal of FOCAL_LENGTHS) {
      expect(focal.prompt).toContain(`${focal.mm}mm`);
    }
  });
});

describe("cinematographyClause", () => {
  it("is null when nothing is set, so a prompt stays byte-identical", () => {
    expect(cinematographyClause(null)).toBeNull();
    expect(cinematographyClause(undefined)).toBeNull();
    expect(cinematographyClause({})).toBeNull();
    expect(cinematographyClause({ camera: null, lens: null })).toBeNull();
  });

  it("compiles a single axis on its own", () => {
    // "Give me shallow depth of field, I don't care what body it was shot on"
    // is a real, useful request — every axis stands alone.
    const clause = cinematographyClause({ aperture: "f1.4" })!;
    expect(clause).toMatch(/f\/1\.4/);
    expect(clause).toMatch(/\.$/);
  });

  it("orders body, lens, focal length, aperture", () => {
    const clause = cinematographyClause({
      camera: "16mm-film",
      lens: "vintage-prime",
      focalLengthMm: 35,
      aperture: "f2.8",
    })!;
    expect(clause.indexOf("16mm film")).toBeLessThan(clause.indexOf("vintage prime"));
    expect(clause.indexOf("vintage prime")).toBeLessThan(clause.indexOf("35mm"));
    expect(clause.indexOf("35mm")).toBeLessThan(clause.indexOf("f/2.8"));
  });

  it("starts as a sentence, not a bag of tags", () => {
    const clause = cinematographyClause({ camera: "70mm-film" })!;
    expect(clause[0]).toBe(clause[0]!.toUpperCase());
  });

  it("ignores an axis that is not in the catalog", () => {
    // A job's options are replayed on every retry; an option removed from the
    // catalog months later must degrade to "not set", never break the render.
    expect(cinematographyClause({ camera: "imax-70mm-imaginary" })).toBeNull();
    const clause = cinematographyClause({ camera: "bogus", aperture: "f4" })!;
    expect(clause).toMatch(/f\/4/);
    expect(clause).not.toMatch(/bogus/);
  });
});

describe("isValidCinematography", () => {
  it("accepts a fully-specified selection and any empty one", () => {
    expect(
      isValidCinematography({
        camera: "full-frame-cine",
        lens: "modern-prime",
        focalLengthMm: 50,
        aperture: "f4",
      }),
    ).toBe(true);
    expect(isValidCinematography({})).toBe(true);
  });

  it("rejects an axis the catalog does not have", () => {
    expect(isValidCinematography({ camera: "phone-camera" })).toBe(false);
    expect(isValidCinematography({ focalLengthMm: 33 })).toBe(false);
    expect(isValidCinematography({ aperture: "f/1.4" })).toBe(false);
  });
});

describe("normalizeCinematography", () => {
  it("collapses an all-unknown selection to null", () => {
    expect(normalizeCinematography({ camera: "nope", lens: "also-nope" })).toBeNull();
  });

  it("keeps the axes that survive", () => {
    expect(normalizeCinematography({ camera: "nope", focalLengthMm: 85 })).toEqual({
      camera: null,
      lens: null,
      aperture: null,
      focalLengthMm: 85,
    });
  });
});
