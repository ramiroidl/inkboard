import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { ControllerConfig } from "../config.js";
import { runMigrations } from "./migrations.js";
import * as schema from "./schema.js";

export interface InkboardDatabase {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
  assertReady(): void;
}

export async function openDatabase(config: ControllerConfig): Promise<InkboardDatabase> {
  await mkdir(dirname(config.databasePath), { recursive: true });
  const raw = new Database(config.databasePath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  // Overwrite deleted content, such as tasks removed on Microsoft sign-out.
  raw.pragma("secure_delete = ON");

  await runMigrations(raw, config.migrationDirectory);

  return {
    raw,
    orm: drizzle(raw, { schema }),
    close: () => raw.close(),
    assertReady: () => {
      raw.prepare("SELECT 1").get();
    },
  };
}
