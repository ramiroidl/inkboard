import sharp from "sharp";

/** Wide enough for "100%" to sit right of the icon without overlapping it. */
const BADGE_WIDTH = 76;
const BADGE_HEIGHT = 22;
/** Right edge lines up with the screen content and footer rule; bottom sits in the footer. */
const RIGHT_MARGIN = 32;
const BOTTOM_MARGIN = 3;
const FONT = "DejaVu Sans, sans-serif";

interface Badge {
  width: number;
  height: number;
  /** One byte per pixel, top to bottom; 1 means black. */
  black: Uint8Array;
}

const cache = new Map<number, Promise<Badge>>();

/** Rounds to 5 % steps so small voltage changes do not redraw the panel. */
export function batteryStep(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent / 5) * 5));
}

export function batteryBadgeSvg(percent: number): string {
  const fill = Math.round((18 * percent) / 100);
  // DejaVu Sans Bold advances: digits 0.696 em, "%" 1.002 em at 12 px.
  const textWidth = String(percent).length * 8.35 + 12;
  const iconX = Math.round(BADGE_WIDTH - 1 - textWidth - 4 - 25);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" viewBox="0 0 ${BADGE_WIDTH} ${BADGE_HEIGHT}">
  <rect width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" fill="white"/>
  <g transform="translate(${iconX - 3} 0)">
    <rect x="3" y="5" width="22" height="12" fill="none" stroke="black" stroke-width="1.5"/>
    <rect x="25" y="8.5" width="2.5" height="5" fill="black"/>
    ${fill > 0 ? `<rect x="5" y="7" width="${fill}" height="8" fill="black"/>` : ""}
  </g>
  <text x="${BADGE_WIDTH - 1}" y="16" font-family="${FONT}" font-size="12" font-weight="700" text-anchor="end">${percent}%</text>
</svg>`;
}

async function renderBadge(percent: number): Promise<Badge> {
  const { data, info } = await sharp(Buffer.from(batteryBadgeSvg(percent)))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(128)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const black = new Uint8Array(info.width * info.height);
  for (let index = 0; index < black.length; index += 1) {
    black[index] = data[index * info.channels]! < 128 ? 1 : 0;
  }
  return { width: info.width, height: info.height, black };
}

/**
 * Draws a battery badge into the lower-right corner of a 1-bit BMP whose palette maps index 0
 * to black and index 1 to white. Returns a new buffer; the input is not changed.
 */
export async function drawBatteryBadge(bmp: Buffer, percent: number): Promise<Buffer> {
  const step = batteryStep(percent);
  let pending = cache.get(step);
  if (pending === undefined) {
    pending = renderBadge(step);
    cache.set(step, pending);
  }
  const badge = await pending;

  const output = Buffer.from(bmp);
  const pixelOffset = output.readUInt32LE(10);
  const width = output.readInt32LE(18);
  const rawHeight = output.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const stride = Math.ceil(width / 32) * 4;
  const left = width - badge.width - RIGHT_MARGIN;
  const top = height - badge.height - BOTTOM_MARGIN;

  for (let y = 0; y < badge.height; y += 1) {
    const imageY = top + y;
    const row = bottomUp ? height - 1 - imageY : imageY;
    for (let x = 0; x < badge.width; x += 1) {
      const imageX = left + x;
      const byteIndex = pixelOffset + row * stride + (imageX >> 3);
      const mask = 0x80 >> (imageX & 7);
      if (badge.black[y * badge.width + x] === 1) {
        output[byteIndex] = output[byteIndex]! & ~mask;
      } else {
        output[byteIndex] = output[byteIndex]! | mask;
      }
    }
  }
  return output;
}
