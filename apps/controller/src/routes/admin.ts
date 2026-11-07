import { readFile } from "node:fs/promises";

import { SEEED_EE04_DISPLAY_PROFILE } from "@inkboard/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { desc, eq } from "drizzle-orm";

import {
  InvalidCalendarSelectionError,
  MAX_SELECTED_CALENDARS,
  type CalendarService,
} from "../calendar/calendar-service.js";
import type { InkboardDatabase } from "../db/database.js";
import type { DisplaySettings } from "../devices/display-settings.js";
import { devices } from "../db/schema.js";
import {
  CustomScreenInputSchema,
  InvalidRotationError,
  InvalidScheduleError,
  QuietHoursSchema,
  RotationSettingsSchema,
  ScheduleRuleInputSchema,
  ScheduleRuleSchema,
  ScreenIdSchema,
  ScreenNotFoundError,
  ScreenWidgetSchema,
  type ScreenService,
} from "../screens/screen-service.js";
import { InvalidWidgetError, type WidgetRegistry } from "../widgets/registry.js";
import type { HomeAssistantStateClient } from "../integrations/home-assistant-states.js";

const ErrorSchema = Type.Object({ error: Type.String() });

const NullableString = Type.Union([Type.String(), Type.Null()]);

const CalendarStatusSchema = Type.Object({
  configured: Type.Boolean(),
  homeAssistantConfigured: Type.Boolean(),
  state: Type.Union([Type.Literal("disabled"), Type.Literal("ready"), Type.Literal("degraded")]),
  entityIds: Type.Array(Type.String()),
  calendars: Type.Array(
    Type.Object({
      entityId: Type.String(),
      name: Type.String(),
      eventCount: Type.Integer(),
      lastSuccessfulRefreshAt: NullableString,
      lastError: NullableString,
    }),
  ),
  timeZone: NullableString,
  lookAheadDays: Type.Union([Type.Integer(), Type.Null()]),
  lastAttemptAt: NullableString,
  lastSuccessfulRefreshAt: NullableString,
  lastError: NullableString,
  eventCount: Type.Integer(),
});

const CustomScreenSchema = Type.Object({
  id: ScreenIdSchema,
  name: Type.String(),
  widgets: Type.Array(ScreenWidgetSchema),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export interface AdminRuntime {
  stateClient: HomeAssistantStateClient | null;
  appMode: "standalone" | "home_assistant";
  devicePort: number | null;
  deviceApiToken: string;
  displaySettings: DisplaySettings;
}

export function adminRoutes(
  version: string,
  database: InkboardDatabase,
  calendarService: CalendarService,
  screenService: ScreenService,
  widgetRegistry: WidgetRegistry,
  runtime: AdminRuntime,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    // Widget settings are validated by each plugin's schema after request validation.
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof InvalidWidgetError) {
        return reply.code(400).send({ error: error.message });
      }
      return reply.send(error);
    });

    app.get(
      "/api/v1/admin/entities",
      {
        schema: {
          querystring: Type.Object({
            domain: Type.Optional(Type.String({ pattern: "^[a-z_]+$", maxLength: 64 })),
          }),
          response: {
            200: Type.Object({
              entities: Type.Array(
                Type.Object({
                  entityId: Type.String(),
                  name: Type.String(),
                  domain: Type.String(),
                }),
              ),
              error: Type.Union([Type.String(), Type.Null()]),
            }),
          },
        },
      },
      async (request) => {
        if (runtime.stateClient === null) {
          return { entities: [], error: "Home Assistant is not configured" };
        }
        try {
          const domain = request.query.domain;
          const entities = await runtime.stateClient.listEntities();
          return {
            entities:
              domain === undefined
                ? entities
                : entities.filter((entity) => entity.domain === domain),
            error: null,
          };
        } catch (error: unknown) {
          return {
            entities: [],
            error: error instanceof Error ? error.message : "Unable to list entities",
          };
        }
      },
    );

    app.get(
      "/api/v1/admin/widgets",
      {
        schema: {
          response: {
            200: Type.Object({
              widgets: Type.Array(
                Type.Object({
                  type: Type.String(),
                  name: Type.String(),
                  description: Type.String(),
                  maxPerRow: Type.Integer(),
                  defaultConfig: Type.Unknown(),
                  configSchema: Type.Unknown(),
                }),
              ),
            }),
          },
        },
      },
      async () => ({ widgets: widgetRegistry.describe() }),
    );

    app.get(
      "/api/v1/admin/status",
      {
        schema: {
          response: {
            200: Type.Object({
              service: Type.Object({
                status: Type.Literal("ok"),
                service: Type.Literal("inkboard-controller"),
                version: Type.String(),
              }),
              displayProfile: Type.Object({
                id: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.id),
                width: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.width),
                height: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.height),
                bitsPerPixel: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.bitsPerPixel),
                expectedBmpBytes: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.expectedBmpBytes),
              }),
              calendar: CalendarStatusSchema,
              app: Type.Object({
                mode: Type.Union([Type.Literal("standalone"), Type.Literal("home_assistant")]),
                devicePort: Type.Union([Type.Integer(), Type.Null()]),
                deviceApiToken: Type.Union([Type.String(), Type.Null()]),
              }),
            }),
          },
        },
      },
      async () => ({
        app: {
          mode: runtime.appMode,
          devicePort: runtime.devicePort,
          // Inside the App the admin API is reachable only through Home Assistant's
          // authenticated ingress, so the device token can be shown for firmware setup.
          deviceApiToken: runtime.appMode === "home_assistant" ? runtime.deviceApiToken : null,
        },
        service: {
          status: "ok" as const,
          service: "inkboard-controller" as const,
          version,
        },
        displayProfile: SEEED_EE04_DISPLAY_PROFILE,
        calendar: calendarService.getStatus(),
      }),
    );

    app.get(
      "/api/v1/admin/calendars",
      {
        schema: {
          response: {
            200: Type.Object({
              available: Type.Array(Type.Object({ entityId: Type.String(), name: Type.String() })),
              selected: Type.Array(Type.String()),
              discoveryError: Type.Union([Type.String(), Type.Null()]),
            }),
          },
        },
      },
      async () => calendarService.listCalendars(),
    );

    app.put(
      "/api/v1/admin/calendars",
      {
        schema: {
          body: Type.Object(
            {
              entityIds: Type.Array(Type.String({ maxLength: 255 }), {
                maxItems: MAX_SELECTED_CALENDARS,
              }),
            },
            { additionalProperties: false },
          ),
          response: { 200: CalendarStatusSchema, 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return await calendarService.setSelection(request.body.entityIds);
        } catch (error: unknown) {
          if (error instanceof InvalidCalendarSelectionError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.get(
      "/api/v1/admin/devices",
      {
        schema: {
          response: {
            200: Type.Object({
              devices: Type.Array(
                Type.Object({
                  id: Type.String(),
                  model: Type.String(),
                  firmwareVersion: Type.String(),
                  width: Type.Integer(),
                  height: Type.Integer(),
                  lastSeenAt: Type.String(),
                  lastScreenRevision: Type.Union([Type.String(), Type.Null()]),
                  lastWakeReason: Type.String(),
                  lastWifiRssi: Type.Union([Type.Number(), Type.Null()]),
                  lastBatteryVoltage: Type.Union([Type.Number(), Type.Null()]),
                  lastButtonEvent: Type.String(),
                  lastDisplayResult: Type.String(),
                  currentScreenId: ScreenIdSchema,
                  invertColors: Type.Boolean(),
                }),
              ),
            }),
          },
        },
      },
      async () => {
        const records = await database.orm.select().from(devices).orderBy(desc(devices.lastSeenAt));
        return {
          devices: records.map((device) => ({
            id: device.id,
            model: device.model,
            firmwareVersion: device.firmwareVersion,
            width: device.width,
            height: device.height,
            lastSeenAt: device.lastSeenAt,
            lastScreenRevision: device.lastScreenRevision,
            lastWakeReason: device.lastWakeReason,
            lastWifiRssi: device.lastWifiRssi,
            lastBatteryVoltage: device.lastBatteryVoltage,
            lastButtonEvent: device.lastButtonEvent,
            lastDisplayResult: device.lastDisplayResult,
            currentScreenId: screenService.resolveScreenId(device.currentScreenId),
            invertColors: runtime.displaySettings.invertColors(device.id),
          })),
        };
      },
    );

    app.get(
      "/api/v1/admin/screens",
      {
        schema: {
          response: {
            200: Type.Object({
              defaultScreenId: ScreenIdSchema,
              screens: Type.Array(
                Type.Object({
                  id: ScreenIdSchema,
                  name: Type.String(),
                  description: Type.String(),
                  kind: Type.Union([Type.Literal("builtin"), Type.Literal("custom")]),
                }),
              ),
              rotation: RotationSettingsSchema,
              schedules: Type.Array(ScheduleRuleSchema),
              quietHours: QuietHoursSchema,
              scheduleState: Type.Object({
                activeRuleId: Type.Union([Type.String(), Type.Null()]),
                quietHoursActive: Type.Boolean(),
              }),
              timeZone: Type.String(),
              testPatternHidden: Type.Boolean(),
            }),
          },
        },
      },
      async () => ({
        defaultScreenId: screenService.defaultScreenId(),
        screens: screenService.listScreens(),
        rotation: screenService.getRotation(),
        schedules: screenService.getSchedules(),
        quietHours: screenService.getQuietHours(),
        scheduleState: screenService.getScheduleState(),
        timeZone: screenService.getTimeZone(),
        testPatternHidden: screenService.isTestPatternHidden(),
      }),
    );

    app.put(
      "/api/v1/admin/test-pattern",
      {
        schema: {
          body: Type.Object({ hidden: Type.Boolean() }, { additionalProperties: false }),
          response: { 200: Type.Object({ hidden: Type.Boolean() }) },
        },
      },
      async (request) => {
        screenService.setTestPatternHidden(request.body.hidden);
        return { hidden: screenService.isTestPatternHidden() };
      },
    );

    app.put(
      "/api/v1/admin/schedules",
      {
        schema: {
          body: Type.Object(
            { rules: Type.Array(ScheduleRuleInputSchema, { maxItems: 32 }) },
            { additionalProperties: false },
          ),
          response: {
            200: Type.Object({ rules: Type.Array(ScheduleRuleSchema) }),
            400: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        try {
          return { rules: screenService.setSchedules(request.body.rules) };
        } catch (error: unknown) {
          if (error instanceof InvalidScheduleError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.put(
      "/api/v1/admin/quiet-hours",
      {
        schema: {
          body: QuietHoursSchema,
          response: { 200: QuietHoursSchema, 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return screenService.setQuietHours(request.body);
        } catch (error: unknown) {
          if (error instanceof InvalidScheduleError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.post(
      "/api/v1/admin/screens",
      {
        schema: {
          body: CustomScreenInputSchema,
          response: { 201: CustomScreenSchema },
        },
      },
      async (request, reply) =>
        reply.code(201).send(screenService.createCustomScreen(request.body)),
    );

    app.get(
      "/api/v1/admin/screens/:screenId",
      {
        schema: {
          params: Type.Object({ screenId: ScreenIdSchema }),
          response: { 200: CustomScreenSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return screenService.getCustomScreen(request.params.screenId);
        } catch (error: unknown) {
          if (error instanceof ScreenNotFoundError) {
            return reply.code(404).send({ error: "Screen not found" });
          }
          throw error;
        }
      },
    );

    app.put(
      "/api/v1/admin/screens/:screenId",
      {
        schema: {
          params: Type.Object({ screenId: ScreenIdSchema }),
          body: CustomScreenInputSchema,
          response: { 200: CustomScreenSchema, 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return screenService.updateCustomScreen(request.params.screenId, request.body);
        } catch (error: unknown) {
          if (error instanceof ScreenNotFoundError) {
            return reply.code(404).send({ error: "Screen not found" });
          }
          throw error;
        }
      },
    );

    app.delete(
      "/api/v1/admin/screens/:screenId",
      {
        schema: {
          params: Type.Object({ screenId: ScreenIdSchema }),
          response: { 204: Type.Null(), 404: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          screenService.deleteCustomScreen(request.params.screenId);
          return reply.code(204).send(null);
        } catch (error: unknown) {
          if (error instanceof ScreenNotFoundError) {
            return reply.code(404).send({ error: "Screen not found" });
          }
          throw error;
        }
      },
    );

    app.post(
      "/api/v1/admin/screens/preview.bmp",
      { schema: { body: CustomScreenInputSchema } },
      async (request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .type("image/bmp")
          .send(await screenService.renderPreview(request.body)),
    );

    app.put(
      "/api/v1/admin/rotation",
      {
        schema: {
          body: RotationSettingsSchema,
          response: { 200: RotationSettingsSchema, 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return screenService.setRotation(request.body);
        } catch (error: unknown) {
          if (error instanceof InvalidRotationError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.get(
      "/api/v1/admin/screens/:screenId/preview.bmp",
      {
        schema: {
          params: Type.Object({ screenId: Type.String({ maxLength: 64 }) }),
        },
      },
      async (request, reply) => {
        if (!screenService.isAvailable(request.params.screenId)) {
          return reply.code(404).send({ error: "Screen not found" });
        }
        const artifact = await screenService.getArtifact(request.params.screenId);
        return reply
          .header("Cache-Control", "no-store")
          .type("image/bmp")
          .send(await readFile(artifact.filePath));
      },
    );

    app.put(
      "/api/v1/admin/devices/:deviceId/screen",
      {
        schema: {
          params: Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 64 }) }),
          body: Type.Object({ screenId: ScreenIdSchema }, { additionalProperties: false }),
          response: {
            200: Type.Object({ deviceId: Type.String(), currentScreenId: ScreenIdSchema }),
            400: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const { screenId } = request.body;
        if (!screenService.isAvailable(screenId)) {
          return reply.code(400).send({ error: "Screen is not available" });
        }
        if (!screenService.setDeviceScreen(request.params.deviceId, screenId)) {
          return reply.code(404).send({ error: "Device not found" });
        }
        return { deviceId: request.params.deviceId, currentScreenId: screenId };
      },
    );

    app.put(
      "/api/v1/admin/devices/:deviceId/display",
      {
        schema: {
          params: Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 64 }) }),
          body: Type.Object({ invertColors: Type.Boolean() }, { additionalProperties: false }),
          response: {
            200: Type.Object({ deviceId: Type.String(), invertColors: Type.Boolean() }),
            404: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const { deviceId } = request.params;
        const known = database.orm
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.id, deviceId))
          .get();
        if (known === undefined) {
          return reply.code(404).send({ error: "Device not found" });
        }
        runtime.displaySettings.setInvertColors(deviceId, request.body.invertColors);
        return { deviceId, invertColors: runtime.displaySettings.invertColors(deviceId) };
      },
    );
  };
}
