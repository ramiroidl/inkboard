import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(set.json()).toEqual({ deviceId: "inkboard-og", invertColors: true });

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
