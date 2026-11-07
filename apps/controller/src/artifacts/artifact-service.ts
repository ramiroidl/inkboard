import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SEEED_EE04_DISPLAY_PROFILE } from "@inkboard/contracts";
import { encodeMonochromeBmp, inspectMonochromeBmp } from "@inkboard/epaper-image";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import type { ControllerConfig } from "../config.js";
import type { InkboardDatabase } from "../db/database.js";
import { artifacts, type ArtifactRecord } from "../db/schema.js";
import type { CalendarEvent } from "../integrations/home-assistant-calendar.js";
import { calendarSvg } from "./calendar-renderer.js";

export const ORIENTATION_CONTENT_KEY = "orientation-v2";
export const CALENDAR_CONTENT_KEY = "calendar-v1";

function orientationSvg(): string {
  return `
    <svg width="800" height="480" viewBox="0 0 800 480" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="480" fill="white"/>
      <rect x="1" y="1" width="798" height="478" fill="none" stroke="black" stroke-width="2"/>
      <line x1="400" y1="0" x2="400" y2="480" stroke="black" stroke-width="2"/>
      <line x1="0" y1="240" x2="800" y2="240" stroke="black" stroke-width="2"/>
      <rect x="28" y="28" width="92" height="92" fill="black"/>
      <circle cx="735" cy="75" r="47" fill="none" stroke="black" stroke-width="8"/>
      <path d="M54 415 L92 342 L130 415 Z" fill="black"/>
      <path d="M682 420 h106 v-72 h-106 z M702 400 h66 v-32 h-66 z" fill="black" fill-rule="evenodd"/>
      <text x="400" y="205" font-family="DejaVu Sans, sans-serif" font-size="54" font-weight="700"
        text-anchor="middle" fill="black">INKBOARD</text>
      <text x="400" y="283" font-family="DejaVu Sans, sans-serif" font-size="30"
        text-anchor="middle" fill="black">SEEED EE04 · 800 × 480 · 1-BIT</text>
      <text x="26" y="462" font-family="DejaVu Sans, sans-serif" font-size="18" fill="black">BOTTOM LEFT</text>
      <text x="774" y="462" font-family="DejaVu Sans, sans-serif" font-size="18"
        text-anchor="end" fill="black">BOTTOM RIGHT</text>
    </svg>
  `;
}

export class ArtifactService {
  public constructor(
    private readonly config: ControllerConfig,
    private readonly database: InkboardDatabase,
  ) {}

  public async initialize(): Promise<void> {
    await mkdir(this.config.artifactDirectory, { recursive: true });
    await this.ensureOrientationArtifact();
  }

  public assertReady(): void {
    this.database.assertReady();
  }

  public async getOrientationArtifact(): Promise<ArtifactRecord> {
    const record = await this.getArtifact(ORIENTATION_CONTENT_KEY);
    if (record === undefined) {
      throw new Error("Orientation artifact has not been generated");
    }
    return record;
  }

  public async getCalendarArtifact(): Promise<ArtifactRecord | undefined> {
    return this.getArtifact(CALENDAR_CONTENT_KEY);
  }

  /** Rasterizes an 800x480 SVG into a validated 1-bit BMP without persisting it. */
  public async rasterize(svg: string, artifactName: string): Promise<Buffer> {
    return this.renderSvg(svg, artifactName);
  }

  public async getArtifactByKey(contentKey: string): Promise<ArtifactRecord | undefined> {
    return this.getArtifact(contentKey);
  }

  public async persistScreenArtifact(contentKey: string, bmp: Buffer): Promise<ArtifactRecord> {
    return this.persistArtifact("screen", contentKey, bmp);
  }

  public async renderCalendarArtifact(
    events: CalendarEvent[],
    options: {
      calendarNames: string[];
      timeZone: string;
      lookAheadDays: number;
      now: Date;
    },
  ): Promise<ArtifactRecord> {
    const bmp = await this.renderSvg(calendarSvg(events, options), "calendar");
    return this.persistArtifact("calendar", CALENDAR_CONTENT_KEY, bmp);
  }

  private async getArtifact(contentKey: string): Promise<ArtifactRecord | undefined> {
    return this.database.orm.query.artifacts.findFirst({
      where: eq(artifacts.contentKey, contentKey),
    });
  }

  private async ensureOrientationArtifact(): Promise<ArtifactRecord> {
    const existing = await this.getArtifact(ORIENTATION_CONTENT_KEY);
    if (existing !== undefined) {
      return existing;
    }

    const bmp = await this.renderSvg(orientationSvg(), "orientation");
    return this.persistArtifact("orientation", ORIENTATION_CONTENT_KEY, bmp);
  }

  private async renderSvg(svg: string, artifactName: string): Promise<Buffer> {
    const { data, info } = await sharp(Buffer.from(svg))
      .flatten({ background: "#ffffff" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (
      info.width !== SEEED_EE04_DISPLAY_PROFILE.width ||
      info.height !== SEEED_EE04_DISPLAY_PROFILE.height ||
      info.channels !== 1
    ) {
      throw new Error(
        `Unexpected ${artifactName} raster ${info.width}x${info.height}x${info.channels}`,
      );
    }

    const bmp = encodeMonochromeBmp({
      width: info.width,
      height: info.height,
      pixels: data,
    });
    const metadata = inspectMonochromeBmp(bmp);
    if (metadata.fileSize !== SEEED_EE04_DISPLAY_PROFILE.expectedBmpBytes) {
      throw new Error(`Unexpected BMP size ${metadata.fileSize}`);
    }
    return bmp;
  }

  private async persistArtifact(
    kind: string,
    contentKey: string,
    bmp: Buffer,
  ): Promise<ArtifactRecord> {
    const metadata = inspectMonochromeBmp(bmp);
    const checksum = createHash("sha256").update(bmp).digest("hex");
    const identical = await this.database.orm.query.artifacts.findFirst({
      where: eq(artifacts.checksum, checksum),
    });
    if (identical !== undefined && identical.contentKey !== contentKey) {
      // Identical pixels are already stored under another content key; reuse that file.
      return identical;
    }
    const filePath = join(this.config.artifactDirectory, `${kind}-${checksum}.bmp`);
    try {
      await access(filePath);
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, bmp, { flag: "wx" });
      await rename(temporaryPath, filePath);
    }

    const record = {
      id: randomUUID(),
      kind,
      contentKey,
      checksum,
      filePath,
      width: metadata.width,
      height: metadata.height,
      bitsPerPixel: metadata.bitsPerPixel,
      byteSize: metadata.fileSize,
      createdAt: new Date().toISOString(),
    };
    await this.database.orm
      .insert(artifacts)
      .values(record)
      .onConflictDoUpdate({
        target: artifacts.contentKey,
        set: {
          kind: record.kind,
          checksum: record.checksum,
          filePath: record.filePath,
          width: record.width,
          height: record.height,
          bitsPerPixel: record.bitsPerPixel,
          byteSize: record.byteSize,
          createdAt: record.createdAt,
        },
      });
    return record;
  }
}
