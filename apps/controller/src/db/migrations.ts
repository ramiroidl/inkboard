import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";

interface AppliedMigration {
  name: string;
  checksum: string;
}

export async function runMigrations(
  database: Database.Database,
  migrationDirectory: string,
): Promise<void> {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inkboard_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const findApplied = database.prepare<[string], AppliedMigration>(
    "SELECT name, checksum FROM inkboard_migrations WHERE name = ?",
  );
  const recordApplied = database.prepare(
    "INSERT INTO inkboard_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
  );

  for (const name of migrationNames) {
    const sql = (await readFile(join(migrationDirectory, name), "utf8")).replaceAll("\r\n", "\n");
    const checksum = sha256(sql);
    const applied = findApplied.get(name);

    if (applied !== undefined) {
      // Databases created before line endings were normalized recorded CRLF checksums.
      if (
        applied.checksum !== checksum &&
        applied.checksum !== sha256(sql.replaceAll("\n", "\r\n"))
      ) {
        throw new Error(`Applied migration ${name} has changed`);
      }
      continue;
    }

    database.transaction(() => {
      database.exec(sql);
      recordApplied.run(name, checksum, new Date().toISOString());
    })();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
