import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { batteryPercent } from "@inkboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("display color inversion", () => {
  it("flips one display's pixels and gives the image a new revision", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-invert-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      INKBOARD_DATA_DIR: dataDirectory,
      INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
      INKBOARD_LOG_LEVEL: "silent",
    });
    const app = await buildApp(config);
    const authorization = ["Bearer", config.deviceApiToken].join(" ");
    const checkIn = async () =>
      app.inject({
        method: "POST",
        url: "/api/v1/device/check-in",
        headers: { authorization },
        payload: {
          deviceId: "inkboard-og",
          firmwareVersion: "0.4.0",
          model: "seeed-ee04-800x480-mono",
          width: 800,
          height: 480,
          wakeReason: "timer",
          buttonEvent: "none",
          displayResult: "displayed",
        },
      });
    const image = async (etag?: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/device/image.bmp?device=inkboard-og",
        headers: { authorization, ...(etag === undefined ? {} : { "if-none-match": etag }) },
      });

    expect((await checkIn()).statusCode).toBe(200);
    const normal = await image();
    const devices = await app.inject({ method: "GET", url: "/api/v1/admin/devices" });
    expect(devices.json()).toMatchObject({ devices: [{ id: "inkboard-og", invertColors: false }] });

    const missing = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/other/display",
      payload: { invertColors: true },
    });
    expect(missing.statusCode).toBe(404);
    const set = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/inkboard-og/display",
      payload: { invertColors: true },
    });
    expect(set.json()).toEqual({ deviceId: "inkboard-og", invertColors: true, showBattery: true });

    // The old revision no longer matches, so the display downloads and redraws.
    const inverted = await image(normal.headers.etag);
    expect(inverted.statusCode).toBe(200);
    expect(inverted.headers.etag).toBe(`${(normal.headers.etag as string).slice(0, -1)}:inverted"`);
    const before = normal.rawPayload;
    const after = inverted.rawPayload;
    const offset = before.readUInt32LE(10);
    expect(after.subarray(0, offset)).toEqual(before.subarray(0, offset));
    for (const index of [offset, offset + 1000, before.length - 1]) {
      expect(after[index]).toBe(before[index]! ^ 0xff);
    }
    expect((await image(inverted.headers.etag as string)).statusCode).toBe(304);
    expect((await checkIn()).json<{ screenRevision: string }>().screenRevision).toMatch(
      /:inverted$/,
    );

    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/inkboard-og/display",
      payload: { invertColors: false },
    });
    expect((await image()).rawPayload).toEqual(before);
    await app.close();
  });
});

describe("battery indicator", () => {
  it("estimates the charge from the voltage", () => {
    expect(batteryPercent(null)).toBeNull();
    expect(batteryPercent(4.3)).toBe(100);
    expect(batteryPercent(4.2)).toBe(100);
    expect(batteryPercent(3.8)).toBe(50);
    expect(batteryPercent(3.775)).toBe(45);
    expect(batteryPercent(3.3)).toBe(0);
    expect(batteryPercent(2.9)).toBe(0);
  });

  it("draws the level in the lower-right corner of each display's image", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-battery-"));
    directories.push(dataDirectory);
    const config = loadConfig({
      NODE_ENV: "test",
      INKBOARD_DATA_DIR: dataDirectory,
      INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
      INKBOARD_LOG_LEVEL: "silent",
    });
    const app = await buildApp(config);
    const authorization = ["Bearer", config.deviceApiToken].join(" ");
    const checkIn = async (batteryVoltage?: number) =>
      app.inject({
        method: "POST",
        url: "/api/v1/device/check-in",
        headers: { authorization },
        payload: {
          deviceId: "inkboard-og",
          firmwareVersion: "0.5.0",
          model: "seeed-ee04-800x480-mono",
          width: 800,
          height: 480,
          wakeReason: "timer",
          buttonEvent: "none",
          displayResult: "displayed",
          ...(batteryVoltage === undefined ? {} : { batteryVoltage }),
        },
      });
    const image = async () =>
      app.inject({
        method: "GET",
        url: "/api/v1/device/image.bmp?device=inkboard-og",
        headers: { authorization },
      });

    // Unknown voltage: no badge.
    await checkIn();
    const plain = await image();
    expect(plain.headers.etag).not.toContain("battery");

    const checked = await checkIn(3.8);
    expect(checked.json<{ screenRevision: string }>().screenRevision).toMatch(/:battery50$/);
    const withBadge = await image();
    expect(withBadge.headers.etag).toMatch(/:battery50"$/);
    const devices = await app.inject({ method: "GET", url: "/api/v1/admin/devices" });
    expect(devices.json()).toMatchObject({ devices: [{ showBattery: true, invertColors: false }] });

    // Only the lower-right corner changes.
    const before = plain.rawPayload;
    const after = withBadge.rawPayload;
    const offset = before.readUInt32LE(10);
    const stride = 100;
    const changedRows = new Set<number>();
    const changedColumns = new Set<number>();
    for (let index = offset; index < before.length; index += 1) {
      if (before[index] !== after[index]) {
        const row = Math.floor((index - offset) / stride);
        changedRows.add(479 - row);
        changedColumns.add(((index - offset) % stride) * 8);
      }
    }
    expect(changedRows.size).toBeGreaterThan(0);
    expect(Math.min(...changedRows)).toBeGreaterThanOrEqual(480 - 3 - 22);
    expect(Math.max(...changedRows)).toBeLessThan(480 - 3);
    expect(Math.min(...changedColumns)).toBeGreaterThanOrEqual(800 - 32 - 76 - 8);
    expect(Math.max(...changedColumns)).toBeLessThan(800 - 32);

    // Small voltage changes in the same 5 % step keep the image.
    await checkIn(3.805);
    expect((await image()).headers.etag).toBe(withBadge.headers.etag);

    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/inkboard-og/display",
      payload: { showBattery: false },
    });
    const hidden = await image();
    expect(hidden.headers.etag).toBe(plain.headers.etag);
    expect(hidden.rawPayload).toEqual(before);
    await app.close();
  });
});
