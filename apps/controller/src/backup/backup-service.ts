import type {
  CustomScreenInput,
  InkboardBackup,
  InkboardBackupImportResult,
  QuietHours,
  RotationSettings,
  ScheduleRuleInput,
} from "@inkboard/contracts";

import type { CalendarService } from "../calendar/calendar-service.js";
import type { ScreenService } from "../screens/screen-service.js";
import type { TodoService } from "../todo/todo-service.js";

export const BACKUP_FORMAT = "inkboard-backup";
export const BACKUP_VERSION = 1;

export class InvalidBackupError extends Error {}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameWidgets(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Exports screens and display settings as JSON, and imports them into another controller,
 * such as when moving from the standalone container to the Home Assistant App. Sign-ins and
 * tokens are never exported.
 */
export class BackupService {
  public constructor(
    private readonly screenService: ScreenService,
    private readonly calendarService: CalendarService,
    private readonly todoService: TodoService | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public export(): InkboardBackup {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: this.now().toISOString(),
      screens: this.screenService.listCustomScreens().map((screen) => ({
        id: screen.id,
        name: screen.name,
        widgets: screen.widgets,
      })),
      rotation: this.screenService.getRotation(),
      schedules: this.screenService.getSchedules().map((rule) => ({
        screenId: rule.screenId,
        days: rule.days,
        start: rule.start,
        end: rule.end,
      })),
      quietHours: this.screenService.getQuietHours(),
      testPatternHidden: this.screenService.isTestPatternHidden(),
      calendars: this.calendarService.getStatus().entityIds,
      todoLists: this.todoService?.getStatus().selectedListIds ?? [],
    };
  }

  /**
   * Adds the backup's screens and applies its settings. Screens that already exist with the
   * same name and widgets are reused, so importing twice does not duplicate them. Rotation
   * and schedule entries for screens that are not available here, such as To Do before
   * signing in, are skipped with a warning.
   */
  public async import(backup: InkboardBackup): Promise<InkboardBackupImportResult> {
    if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
      throw new InvalidBackupError("This file is not an Inkboard backup");
    }
    const warnings: string[] = [];

    if (backup.calendars.length > 0) {
      try {
        await this.calendarService.setSelection(backup.calendars);
      } catch (error: unknown) {
        warnings.push(`Calendars were not imported: ${describe(error)}`);
      }
    }
    if (backup.todoLists.length > 0) {
      if (this.todoService === null) {
        warnings.push("To Do lists were not imported: Microsoft To Do is unavailable");
      } else {
        try {
          await this.todoService.setSelection(backup.todoLists);
        } catch (error: unknown) {
          warnings.push(`To Do lists were not imported: ${describe(error)}`);
        }
      }
    }

    const existing = this.screenService.listCustomScreens();
    const idMap = new Map<string, string>();
    let created = 0;
    let reused = 0;
    for (const screen of backup.screens) {
      const match = existing.find(
        (candidate) =>
          candidate.name === screen.name && sameWidgets(candidate.widgets, screen.widgets),
      );
      if (match !== undefined) {
        idMap.set(screen.id, match.id);
        reused += 1;
        continue;
      }
      try {
        const input: CustomScreenInput = { name: screen.name, widgets: screen.widgets };
        idMap.set(screen.id, this.screenService.createCustomScreen(input).id);
        created += 1;
      } catch (error: unknown) {
        warnings.push(`Screen "${screen.name}" was not imported: ${describe(error)}`);
      }
    }

    const mapId = (screenId: string): string | null => {
      const mapped = idMap.get(screenId) ?? screenId;
      return this.screenService.isAvailable(mapped) ? mapped : null;
    };
    const skipped = (screenId: string, where: string) => {
      const name = backup.screens.find((screen) => screen.id === screenId)?.name ?? screenId;
      warnings.push(`"${name}" was left out of ${where} because it is not available here`);
    };

    const screenIds: string[] = [];
    for (const screenId of backup.rotation.screenIds) {
      const mapped = mapId(screenId);
      if (mapped === null) {
        skipped(screenId, "the rotation");
      } else if (!screenIds.includes(mapped)) {
        screenIds.push(mapped);
      }
    }
    try {
      const rotation: RotationSettings = {
        screenIds,
        intervalMinutes: backup.rotation.intervalMinutes,
      };
      this.screenService.setRotation(rotation);
    } catch (error: unknown) {
      warnings.push(`The rotation was not imported: ${describe(error)}`);
    }

    const schedules: ScheduleRuleInput[] = [];
    for (const rule of backup.schedules) {
      const mapped = mapId(rule.screenId);
      if (mapped === null) {
        skipped(rule.screenId, "the schedules");
      } else {
        schedules.push({ screenId: mapped, days: rule.days, start: rule.start, end: rule.end });
      }
    }
    try {
      this.screenService.setSchedules(schedules);
    } catch (error: unknown) {
      warnings.push(`Schedules were not imported: ${describe(error)}`);
    }

    try {
      const quietHours: QuietHours = backup.quietHours;
      this.screenService.setQuietHours(quietHours);
    } catch (error: unknown) {
      warnings.push(`Quiet hours were not imported: ${describe(error)}`);
    }
    this.screenService.setTestPatternHidden(backup.testPatternHidden);

    return { screensCreated: created, screensReused: reused, warnings };
  }
}
