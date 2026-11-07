export interface MonochromeRaster {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface BmpMetadata {
  width: number;
  height: number;
  bitsPerPixel: number;
  fileSize: number;
  pixelOffset: number;
}

const FILE_HEADER_BYTES = 14;
const INFO_HEADER_BYTES = 40;
const PALETTE_BYTES = 8;
const PIXEL_OFFSET = FILE_HEADER_BYTES + INFO_HEADER_BYTES + PALETTE_BYTES;

function rowStride(width: number): number {
  return Math.ceil(width / 32) * 4;
}

export function encodeMonochromeBmp(raster: MonochromeRaster, threshold = 128): Buffer {
  const { width, height, pixels } = raster;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("Raster dimensions must be positive integers");
  }
  if (pixels.length !== width * height) {
    throw new RangeError(`Expected ${width * height} pixels, received ${pixels.length}`);
  }
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError("Threshold must be an integer from 0 through 255");
  }

  const stride = rowStride(width);
  const pixelBytes = stride * height;
  const fileSize = PIXEL_OFFSET + pixelBytes;
  const bmp = Buffer.alloc(fileSize, 0);

  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(fileSize, 2);
  bmp.writeUInt32LE(PIXEL_OFFSET, 10);

  bmp.writeUInt32LE(INFO_HEADER_BYTES, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(1, 28);
  bmp.writeUInt32LE(0, 30);
  bmp.writeUInt32LE(pixelBytes, 34);
  bmp.writeInt32LE(2_835, 38);
  bmp.writeInt32LE(2_835, 42);
  bmp.writeUInt32LE(2, 46);
  bmp.writeUInt32LE(2, 50);

  bmp.set([0x00, 0x00, 0x00, 0x00], 54);
  bmp.set([0xff, 0xff, 0xff, 0x00], 58);

  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    const destinationY = height - 1 - sourceY;
    const rowOffset = PIXEL_OFFSET + destinationY * stride;
    for (let x = 0; x < width; x += 1) {
      if (pixels[sourceY * width + x]! >= threshold) {
        bmp[rowOffset + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }

  return bmp;
}

export function inspectMonochromeBmp(bmp: Uint8Array): BmpMetadata {
  const view = Buffer.from(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  if (view.length < PIXEL_OFFSET || view.toString("ascii", 0, 2) !== "BM") {
    throw new Error("Not a BMP file");
  }

  const metadata = {
    fileSize: view.readUInt32LE(2),
    pixelOffset: view.readUInt32LE(10),
    width: view.readInt32LE(18),
    height: view.readInt32LE(22),
    bitsPerPixel: view.readUInt16LE(28),
  };

  if (metadata.fileSize !== view.length) {
    throw new Error(`BMP header size ${metadata.fileSize} does not match ${view.length} bytes`);
  }
  if (metadata.pixelOffset !== PIXEL_OFFSET) {
    throw new Error(`Expected pixel offset ${PIXEL_OFFSET}, received ${metadata.pixelOffset}`);
  }
  if (metadata.width <= 0 || metadata.height <= 0 || metadata.bitsPerPixel !== 1) {
    throw new Error("BMP must be a bottom-up, 1-bit image with positive dimensions");
  }
  if (view.readUInt16LE(26) !== 1 || view.readUInt32LE(30) !== 0) {
    throw new Error("BMP must have one plane and no compression");
  }

  const expectedSize = PIXEL_OFFSET + rowStride(metadata.width) * metadata.height;
  if (expectedSize !== view.length) {
    throw new Error(`Expected ${expectedSize} bytes for BMP dimensions, received ${view.length}`);
  }

  return metadata;
}
