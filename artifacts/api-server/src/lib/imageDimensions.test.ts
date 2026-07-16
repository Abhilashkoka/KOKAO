import { describe, it, expect } from "vitest";
import { getImageDimensions, dimensionsCompatible } from "./imageDimensions";

function pngBytes(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}

function jpegBytes(width: number, height: number): Uint8Array {
  // SOI + APP0 (minimal) + SOF0 with the frame dimensions.
  const b = Buffer.alloc(2 + 4 + 2 + 2 + 2 + 7);
  let i = 0;
  b[i++] = 0xff;
  b[i++] = 0xd8; // SOI
  b[i++] = 0xff;
  b[i++] = 0xe0; // APP0
  b.writeUInt16BE(4, i); // APP0 length (2 length bytes + 2 payload)
  i += 4;
  b[i++] = 0xff;
  b[i++] = 0xc0; // SOF0
  b.writeUInt16BE(9, i);
  i += 2;
  b[i++] = 8; // precision
  b.writeUInt16BE(height, i);
  i += 2;
  b.writeUInt16BE(width, i);
  return new Uint8Array(b);
}

describe("getImageDimensions", () => {
  it("parses PNG headers", () => {
    expect(getImageDimensions(pngBytes(1024, 512))).toEqual({
      width: 1024,
      height: 512,
    });
  });

  it("parses JPEG SOF0 headers", () => {
    expect(getImageDimensions(jpegBytes(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("returns null for unknown bytes", () => {
    expect(getImageDimensions(new Uint8Array(Buffer.from("not an image")))).toBe(
      null,
    );
    expect(getImageDimensions(new Uint8Array(0))).toBe(null);
  });
});

describe("dimensionsCompatible", () => {
  const expected = { width: 1024, height: 512 };

  it("accepts an exact match", () => {
    expect(dimensionsCompatible(expected, { width: 1024, height: 512 })).toBe(
      true,
    );
  });

  it("accepts a same-aspect downscaled rendition", () => {
    expect(dimensionsCompatible(expected, { width: 512, height: 256 })).toBe(
      true,
    );
  });

  it("rejects an upscaled rendition even with the same aspect", () => {
    expect(dimensionsCompatible(expected, { width: 2048, height: 1024 })).toBe(
      false,
    );
  });

  it("rejects a different aspect ratio", () => {
    expect(dimensionsCompatible(expected, { width: 640, height: 480 })).toBe(
      false,
    );
    expect(dimensionsCompatible(expected, { width: 1024, height: 1024 })).toBe(
      false,
    );
  });
});
