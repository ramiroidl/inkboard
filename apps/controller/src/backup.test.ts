import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InkboardBackup, InkboardBackupImportResult } from "@inkboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createApp() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-backup-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    INKBOARD_DATA_DIR: dataDirectory,
    INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
    INKBOARD_LOG_LEVEL: "silent",
    INKBOARD_TIME_ZONE: "America/Chicago",
  });
  return buildApp(config, { now: () => new Date("2026-11-06T12:00:00Z") });
}

type App = Awaited<ReturnType<typeof createApp>>;

async function importBackup(app: App, backup: unknown) {
  return app.inject({ method: "POST", url: "/api/v1/admin/backup", payload: backup as object });
}

describe("backup", () => {
  it("moves screens and settings to another controller", async () => {
    const source = await createApp();
    const created = await source.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: {
        name: "Notes",
        widgets: [
          { type: "heading", text: "Hello" },
          { type: "text", text: "From the old controller" },
        ],
      },
    });
    const notesId = created.json<{ id: string }>().id;
    await source.inject({
      method: "PUT",
      url: "/api/v1/admin/rotation",
      payload: { screenIds: [notesId, "orientation"], intervalMinutes: 20 },
    });
    await source.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules",
      payload: { rules: [{ screenId: notesId, days: [1, 2], start: "07:00", end: "09:00" }] },
    });
    await source.inject({
      method: "PUT",
      url: "/api/v1/admin/quiet-hours",
      payload: { enabled: true, start: "23:00", end: "06:00" },
    });

    const exported = await source.inject({ method: "GET", url: "/api/v1/admin/backup" });
    expect(exported.headers["content-disposition"]).toContain("inkboard-backup-2026-11-06.json");
    const backup = exported.json<InkboardBackup>();
    expect(backup).toMatchObject({
      format: "inkboard-backup",
      version: 1,
      screens: [{ id: notesId, name: "Notes" }],
      rotation: { screenIds: [notesId, "orientation"], intervalMinutes: 20 },
      quietHours: { enabled: true, start: "23:00", end: "06:00" },
      calendars: [],
      todoLists: [],
    });
    expect(JSON.stringify(backup)).not.toMatch(/token/i);
    await source.close();

    // A To Do screen that is not available on the target is skipped with a warning.
    backup.rotation.screenIds.push("todo");
    const target = await createApp();
    const imported = await importBackup(target, backup);
    expect(imported.statusCode).toBe(200);
    const result = imported.json<InkboardBackupImportResult>();
    expect(result).toMatchObject({ screensCreated: 1, screensReused: 0 });
    expect(result.warnings).toEqual([
      '"todo" was left out of the rotation because it is not available here',
    ]);

    const screens = await target.inject({ method: "GET", url: "/api/v1/admin/screens" });
    const body = screens.json<{
      screens: { id: string; name: string; kind: string }[];
      rotation: { screenIds: string[]; intervalMinutes: number };
      schedules: { screenId: string; start: string }[];
      quietHours: { enabled: boolean };
    }>();
    const newId = body.screens.find((screen) => screen.name === "Notes")!.id;
    expect(newId).toMatch(/^screen_/);
    expect(body.rotation).toEqual({ screenIds: [newId, "orientation"], intervalMinutes: 20 });
    expect(body.schedules).toMatchObject([{ screenId: newId, start: "07:00" }]);
    expect(body.quietHours.enabled).toBe(true);

    // Importing again reuses the screen instead of duplicating it.
    const again = await importBackup(target, backup);
    expect(again.json()).toMatchObject({ screensCreated: 0, screensReused: 1 });
    const after = await target.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(
      after.json<{ screens: { kind: string }[] }>().screens.filter((s) => s.kind === "custom"),
    ).toHaveLength(1);

    // Invalid widgets are reported without stopping the import.
    const broken = await importBackup(target, {
      ...backup,
      screens: [{ id: "screen_x", name: "Broken", widgets: [{ type: "no-such-widget" }] }],
      rotation: { screenIds: [], intervalMinutes: 15 },
    });
    expect(broken.json<InkboardBackupImportResult>().warnings[0]).toContain(
      'Screen "Broken" was not imported',
    );

    expect((await importBackup(target, { format: "other", version: 1 })).statusCode).toBe(400);
    await target.close();
  });
});
