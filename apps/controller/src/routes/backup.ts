import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { InvalidBackupError, type BackupService } from "../backup/backup-service.js";
import { QuietHoursSchema, ScreenIdSchema, ScreenWidgetSchema } from "../screens/screen-service.js";

const ClockSchema = Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" });

const BackupSchema = Type.Object({
  format: Type.Literal("inkboard-backup"),
  version: Type.Union([Type.Literal(1), Type.Literal(2)]),
  exportedAt: Type.String({ maxLength: 64 }),
  screens: Type.Array(
    Type.Object({
      id: ScreenIdSchema,
      name: Type.String({ minLength: 1, maxLength: 60 }),
      widgets: Type.Array(ScreenWidgetSchema, { maxItems: 12 }),
    }),
    { maxItems: 200 },
  ),
  rotation: Type.Object({
    screenIds: Type.Array(ScreenIdSchema, { maxItems: 32 }),
    intervalMinutes: Type.Integer({ minimum: 5, maximum: 1440 }),
  }),
  schedules: Type.Array(
    Type.Object({
      screenId: ScreenIdSchema,
      days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }),
      start: ClockSchema,
      end: ClockSchema,
    }),
    { maxItems: 50 },
  ),
  quietHours: QuietHoursSchema,
  testPatternHidden: Type.Boolean(),
  calendars: Type.Array(Type.String({ maxLength: 255 }), { maxItems: 10 }),
  todoLists: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 20 }),
});

/** Export and import of screens and display settings. */
export function backupRoutes(backupService: BackupService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/api/v1/admin/backup", async (_request, reply) => {
      const backup = backupService.export();
      const date = backup.exportedAt.slice(0, 10);
      return reply
        .header("content-disposition", `attachment; filename="inkboard-backup-${date}.json"`)
        .send(backup);
    });

    app.post(
      "/api/v1/admin/backup",
      {
        bodyLimit: 1024 * 1024,
        schema: {
          body: BackupSchema,
          response: {
            200: Type.Object({
              screensCreated: Type.Integer(),
              screensReused: Type.Integer(),
              warnings: Type.Array(Type.String()),
            }),
            400: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        try {
          return await backupService.import(request.body);
        } catch (error: unknown) {
          if (error instanceof InvalidBackupError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );
  };
}
