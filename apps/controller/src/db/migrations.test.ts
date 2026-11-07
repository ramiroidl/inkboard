import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "./migrations.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(contents: string) {
  const directory = await mkdtemp(join(tmpdir(), "inkboard-migrations-"));
  directories.push(directory);
  await writeFile(join(directory, "0000_test.sql"), contents);
  return directory;
}

describe("migrations", () => {
  it("accepts databases that recorded either CRLF or LF checksums", async () => {
    for (const recordedEnding of ["\r\n", "\n"]) {
      const directory = await setup("CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);\n");
      const database = new Database(":memory:");
      database.exec(
        "CREATE TABLE inkboard_migrations (name TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT)",
      );
      const recorded = "CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);\n".replaceAll(
        "\n",
        recordedEnding,
      );
      database
        .prepare("INSERT INTO inkboard_migrations VALUES (?, ?, ?)")
        .run("0000_test.sql", createHash("sha256").update(recorded).digest("hex"), "x");

      await expect(runMigrations(database, directory)).resolves.toBeUndefined();
      database.close();
    }
  });

  it("applies new migrations and rejects edited ones", async () => {
    const directory = await setup("CREATE TABLE a (id TEXT);\r\n");
    const database = new Database(":memory:");
    await runMigrations(database, directory);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeTruthy();

    await writeFile(join(directory, "0000_test.sql"), "CREATE TABLE changed (id TEXT);\n");
    await expect(runMigrations(database, directory)).rejects.toThrow("has changed");
    database.close();
  });
});
