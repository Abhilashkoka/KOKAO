import { describe, it, expect } from "vitest";
import { ASPECT_DIMENSIONS, VIDEO_ASPECTS, providerAspect } from "./types";

describe("ASPECT_DIMENSIONS", () => {
  it("covers every advertised aspect", () => {
    expect(VIDEO_ASPECTS.length).toBe(Object.keys(ASPECT_DIMENSIONS).length);
  });

  it("uses even dimensions, which H.264 yuv420p requires", () => {
    for (const [aspect, { width, height }] of Object.entries(ASPECT_DIMENSIONS)) {
      expect(width % 2, `${aspect} width`).toBe(0);
      expect(height % 2, `${aspect} height`).toBe(0);
    }
  });

  it("matches the ratio it is named for, within a rounding pixel", () => {
    for (const [aspect, { width, height }] of Object.entries(ASPECT_DIMENSIONS)) {
      const [w, h] = aspect.split(":").map(Number);
      expect(Math.abs(width / height - w! / h!), aspect).toBeLessThan(0.01);
    }
  });

  it("keeps the short-form frames at the same 1080 short edge", () => {
    // A 4:5 reel and a 9:16 reel should carry the same vertical resolution and
    // the same upload-size budget; only 21:9 opts out (see the type doc).
    expect(ASPECT_DIMENSIONS["9:16"].width).toBe(1080);
    expect(ASPECT_DIMENSIONS["4:5"].width).toBe(1080);
    expect(ASPECT_DIMENSIONS["1:1"].width).toBe(1080);
    expect(ASPECT_DIMENSIONS["3:4"].width).toBe(1080);
  });
});

describe("providerAspect", () => {
  const WAN = ["16:9", "9:16", "1:1"] as const;

  it("passes a supported ratio straight through", () => {
    expect(providerAspect("9:16", WAN)).toBe("9:16");
    expect(providerAspect("16:9", WAN)).toBe("16:9");
  });

  it("sends 4:5 to square, not portrait — the smaller crop", () => {
    // 1:1 -> 4:5 crops 10% off each side. 9:16 -> 4:5 would throw away a third
    // of the frame and with it whatever the subject was standing next to.
    expect(providerAspect("4:5", WAN)).toBe("1:1");
  });

  it("breaks an exact tie on orientation, not on floating-point noise", () => {
    // 3:4 sits exactly between 1:1 and 9:16; 4:3 exactly between 1:1 and 16:9.
    // Both resolve to the source with the same orientation as the request.
    expect(providerAspect("3:4", WAN)).toBe("9:16");
    expect(providerAspect("4:3", WAN)).toBe("16:9");
  });

  it("is deterministic across repeated calls", () => {
    const first = VIDEO_ASPECTS.map((a) => providerAspect(a, WAN));
    const second = VIDEO_ASPECTS.map((a) => providerAspect(a, WAN));
    expect(second).toEqual(first);
  });

  it("sends cinemascope to the widest ratio available", () => {
    expect(providerAspect("21:9", WAN)).toBe("16:9");
  });

  it("honours a narrower support list, as Sora needs", () => {
    const sora = ["16:9", "9:16"] as const;
    expect(providerAspect("1:1", sora)).toBe("16:9");
    expect(providerAspect("4:5", sora)).toBe("9:16");
    expect(providerAspect("3:4", sora)).toBe("9:16");
  });

  it("never returns a ratio outside the support list", () => {
    for (const aspect of VIDEO_ASPECTS) {
      expect(WAN).toContain(providerAspect(aspect, WAN));
    }
  });
});
