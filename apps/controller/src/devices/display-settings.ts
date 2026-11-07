import type { SettingsStore } from "../db/settings-store.js";

const KEY_PREFIX = "displaySettings:";

interface StoredDisplaySettings {
  invertColors?: boolean;
}

/**
 * Per-display options stored in the settings table. `invertColors` fixes panels that show
 * white on black: the controller flips the image before sending it to that display.
 */
export class DisplaySettings {
  public constructor(private readonly store: SettingsStore) {}

  public invertColors(deviceId: string | null | undefined): boolean {
    if (deviceId === null || deviceId === undefined) {
      return false;
    }
    return this.store.get<StoredDisplaySettings>(`${KEY_PREFIX}${deviceId}`)?.invertColors === true;
  }

  public setInvertColors(deviceId: string, invertColors: boolean): void {
    const current = this.store.get<StoredDisplaySettings>(`${KEY_PREFIX}${deviceId}`) ?? {};
    this.store.set(`${KEY_PREFIX}${deviceId}`, { ...current, invertColors });
  }
}

/** The revision a display reports; inverted images get their own so the panel redraws. */
export function screenRevision(checksum: string, inverted: boolean): string {
  return inverted ? `sha256:${checksum}:inverted` : `sha256:${checksum}`;
}

/**
 * Flips every pixel of a 1-bit BMP and keeps its palette. The firmware draws pixels by
 * index rather than by palette color, so flipping the bits inverts what the panel shows.
 */
export function invertBmpPixels(bmp: Buffer): Buffer {
  const pixelOffset = bmp.readUInt32LE(10);
  const inverted = Buffer.from(bmp);
  for (let index = pixelOffset; index < inverted.length; index += 1) {
    inverted[index] = inverted[index]! ^ 0xff;
  }
  return inverted;
}
