import { eq } from "drizzle-orm";

import type { InkboardDatabase } from "./database.js";
import { settings } from "./schema.js";

/** JSON values in the `settings` table, keyed by name. */
export class SettingsStore {
  public constructor(
    private readonly database: InkboardDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public get<T>(key: string): T | undefined {
    const row = this.database.orm.select().from(settings).where(eq(settings.key, key)).get();
    if (row === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return undefined;
    }
  }

  public set(key: string, value: unknown): void {
    const updatedAt = this.now().toISOString();
    const valueJson = JSON.stringify(value);
    this.database.orm
      .insert(settings)
      .values({ key, valueJson, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt } })
      .run();
  }

  public delete(key: string): void {
    this.database.orm.delete(settings).where(eq(settings.key, key)).run();
  }

  /** Deletes every key that starts with `prefix`. */
  public deletePrefix(prefix: string): void {
    const keys = this.database.orm
      .select({ key: settings.key })
      .from(settings)
      .all()
      .map((row) => row.key)
      .filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      this.delete(key);
    }
  }
}
