import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeMonochromeBmp, inspectMonochromeBmp } from "./index.js";

describe("1-bit BMP encoding", () => {
  it("encodes the Seeed display dimensions exactly", () => {
    const pixels = new Uint8Array(800 * 480).fill(255);
    const bmp = encodeMonochromeBmp({ width: 800, height: 480, pixels });

    expect(bmp).toHaveLength(48_062);
    expect(inspectMonochromeBmp(bmp)).toEqual({
      width: 800,
      height: 480,
      bitsPerPixel: 1,
      fileSize: 48_062,
      pixelOffset: 62,
    });
  });

  it("produces deterministic output", () => {
    const pixels = Uint8Array.from({ length: 32 * 4 }, (_, index) => index % 256);
    const first = encodeMonochromeBmp({ width: 32, height: 4, pixels });
    const second = encodeMonochromeBmp({ width: 32, height: 4, pixels });

    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });

  it("rejects an incorrectly sized raster", () => {
    expect(() =>
      encodeMonochromeBmp({ width: 10, height: 10, pixels: new Uint8Array(99) }),
    ).toThrow(/Expected 100 pixels/);
  });
});
