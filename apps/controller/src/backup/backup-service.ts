import type {
  CustomScreenInput,
  InkboardBackup,
  InkboardBackupImportResult,
  QuietHours,
  RotationSettings,
  ScheduleRuleInput,
} from "@inkboard/contracts";

import { materializeWidgetSelections, type ScreenService } from "../screens/screen-service.js";

export const BACKUP_FORMAT = "inkboard-backup";
export const BACKUP_VERSION = 2;

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
      rotation: this.screenService.getRotation({ includeHidden: true }),
      schedules: this.screenService.getSchedules({ includeHidden: true }).map((rule) => ({
        screenId: rule.screenId,
        days: rule.days,
        start: rule.start,
        end: rule.end,
      })),
      quietHours: this.screenService.getQuietHours(),
      testPatternHidden: this.screenService.isTestPatternHidden(),
      hiddenScreens: this.screenService.listHiddenScreenIds(),
      calendars: [],
      todoLists: [],
    };
  }

  /**
   * Adds the backup's screens and applies its settings. Screens that already exist with the
   * same name and widgets are reused, so importing twice does not duplicate them. Rotation
   * and schedule entries for missing screens are skipped with a warning. Connections are
   * independent of screens and are not changed by imports.
   */
  public async import(backup: InkboardBackup): Promise<InkboardBackupImportResult> {
    if (
      backup.format !== BACKUP_FORMAT ||
      (backup.version !== 1 && backup.version !== BACKUP_VERSION)
    ) {
      throw new InvalidBackupError("This file is not an Inkboard backup");
    }
    const warnings: string[] = [];

    const screens = [...backup.screens];
    if (backup.version === 1) {
      const references = new Set([
        ...backup.rotation.screenIds,
        ...backup.schedules.map((rule) => rule.screenId),
      ]);
      for (const id of ["calendar", "todo"] as const) {
        if (references.has(id) && !screens.some((screen) => screen.id === id)) {
          screens.push({
            id,
            ...this.screenService.legacyScreenInput(id, backup.calendars, backup.todoLists),
          });
        }
      }
    }
    const existing = this.screenService.listCustomScreens();
    const idMap = new Map<string, string>();
    let created = 0;
    let reused = 0;
    for (const screen of screens) {
      const widgets =
        backup.version === 1
          ? materializeWidgetSelections(screen.widgets, backup.calendars, backup.todoLists)
          : screen.widgets;
      const match = existing.find(
        (candidate) => candidate.name === screen.name && sameWidgets(candidate.widgets, widgets),
      );
      if (match !== undefined) {
        idMap.set(screen.id, match.id);
        reused += 1;
        continue;
      }
      try {
        const input: CustomScreenInput = { name: screen.name, widgets };
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
    // Hide screens last so their rotation and schedule entries are kept for later.
    for (const screenId of backup.hiddenScreens ?? []) {
      const mapped = idMap.get(screenId);
      if (mapped !== undefined) {
        this.screenService.setHidden(mapped, true);
      }
    }

    return { screensCreated: created, screensReused: reused, warnings };
  }
}
