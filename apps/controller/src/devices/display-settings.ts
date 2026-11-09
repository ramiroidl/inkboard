import type { SettingsStore } from "../db/settings-store.js";

const KEY_PREFIX = "displaySettings:";

export interface DisplayOptions {
  /** Flip the image, for panels that show white on black. */
  invertColors: boolean;
  /** Draw the battery level in the lower-right corner. */
  showBattery: boolean;
}

const DEFAULTS: DisplayOptions = { invertColors: false, showBattery: true };

/** Per-display options stored in the settings table. */
export class DisplaySettings {
  public constructor(private readonly store: SettingsStore) {}

  public get(deviceId: string | null | undefined): DisplayOptions {
    if (deviceId === null || deviceId === undefined) {
      return { ...DEFAULTS, showBattery: false };
    }
    return {
      ...DEFAULTS,
      ...this.store.get<Partial<DisplayOptions>>(`${KEY_PREFIX}${deviceId}`),
    };
  }

  public invertColors(deviceId: string | null | undefined): boolean {
    return this.get(deviceId).invertColors;
  }

  public update(deviceId: string, changes: Partial<DisplayOptions>): DisplayOptions {
    const current = this.store.get<Partial<DisplayOptions>>(`${KEY_PREFIX}${deviceId}`) ?? {};
    this.store.set(`${KEY_PREFIX}${deviceId}`, { ...current, ...changes });
    return this.get(deviceId);
  }
}

/**
 * The revision a display reports. Inverted images and each battery step get their own, so
 * the panel redraws when either changes.
 */
export function screenRevision(
  checksum: string,
  variant: { inverted: boolean; batteryStep?: number | null },
): string {
  return [
    `sha256:${checksum}`,
    ...(variant.batteryStep === null || variant.batteryStep === undefined
      ? []
      : [`battery${variant.batteryStep}`]),
    ...(variant.inverted ? ["inverted"] : []),
  ].join(":");
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
