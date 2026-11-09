import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  batteryPercent,
  DEVICE_BUTTON_EVENTS,
  DEVICE_DISPLAY_RESULTS,
  DEVICE_WAKE_REASONS,
  SEEED_EE04_DISPLAY_PROFILE,
} from "@inkboard/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";

import type { InkboardDatabase } from "../db/database.js";
import { deviceCheckIns, devices } from "../db/schema.js";
import { SettingsStore } from "../db/settings-store.js";
import { batteryStep as batteryStepOf, drawBatteryBadge } from "../devices/battery-badge.js";
import { DisplaySettings, invertBmpPixels, screenRevision } from "../devices/display-settings.js";
import { ScreenIdSchema, type ScreenService } from "../screens/screen-service.js";

function hasValidBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return false;
  }

  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function deviceRoutes(
  screenService: ScreenService,
  database: InkboardDatabase,
  deviceApiToken: string,
  clock: () => Date = () => new Date(),
  displaySettings: DisplaySettings = new DisplaySettings(new SettingsStore(database, clock)),
): FastifyPluginAsyncTypebox {
  const storedScreenId = (deviceId: string): string | null =>
    database.orm
      .select({ currentScreenId: devices.currentScreenId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .get()?.currentScreenId ?? null;

  /** How this display's image differs from the shared screen image. */
  const variantFor = (
    deviceId: string | null | undefined,
  ): { inverted: boolean; batteryStep: number | null } => {
    const options = displaySettings.get(deviceId);
    let batteryStep: number | null = null;
    if (options.showBattery && deviceId !== null && deviceId !== undefined) {
      const voltage = database.orm
        .select({ voltage: devices.lastBatteryVoltage })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .get()?.voltage;
      const percent = batteryPercent(voltage);
      batteryStep = percent === null ? null : batteryStepOf(percent);
    }
    return { inverted: options.invertColors, batteryStep };
  };

  return async (app) => {
    app.get(
      "/api/v1/device/image.bmp",
      {
        schema: {
          querystring: Type.Object({
            device: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          }),
        },
      },
      async (request, reply) => {
        if (!hasValidBearerToken(request.headers.authorization, deviceApiToken)) {
          return reply
            .header("WWW-Authenticate", "Bearer")
            .code(401)
            .send({ error: "Unauthorized" });
        }

        const deviceId = request.query.device;
        if (
          deviceId !== undefined &&
          request.headers["if-none-match"] !== undefined &&
          screenService.isQuietHours() &&
          !screenService.hasRecentManualRequest(deviceId)
        ) {
          // Quiet hours keep the current image so the panel does not redraw overnight.
          return reply.header("X-Quiet-Hours", "1").code(304).send();
        }
        const screenId = screenService.currentScreenForDevice(deviceId ?? null);
        const artifact = await screenService.getArtifact(screenId);
        const variant = variantFor(deviceId);
        const revision = screenRevision(artifact.checksum, variant);
        const etag = `"${revision}"`;
        reply.header("X-Screen-Id", screenId);
        if (request.headers["if-none-match"] === etag) {
          return reply.code(304).send();
        }

        let bmp: Buffer = await readFile(artifact.filePath);
        if (variant.batteryStep !== null) {
          bmp = await drawBatteryBadge(bmp, variant.batteryStep);
        }
        return reply
          .header("ETag", etag)
          .header("Cache-Control", "private, no-cache")
          .header("X-Screen-Revision", revision)
          .type("image/bmp")
          .send(variant.inverted ? invertBmpPixels(bmp) : bmp);
      },
    );

    app.post(
      "/api/v1/device/check-in",
      {
        schema: {
          body: Type.Object(
            {
              deviceId: Type.String({ minLength: 1, maxLength: 64 }),
              firmwareVersion: Type.String({ minLength: 1, maxLength: 64 }),
              model: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.id),
              width: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.width),
              height: Type.Literal(SEEED_EE04_DISPLAY_PROFILE.height),
              screenRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
              wakeReason: Type.Union(DEVICE_WAKE_REASONS.map((value) => Type.Literal(value))),
              wifiRssi: Type.Optional(Type.Number({ minimum: -150, maximum: 0 })),
              batteryVoltage: Type.Optional(Type.Number({ minimum: 0, maximum: 6 })),
              buttonEvent: Type.Union(DEVICE_BUTTON_EVENTS.map((value) => Type.Literal(value))),
              displayResult: Type.Union(DEVICE_DISPLAY_RESULTS.map((value) => Type.Literal(value))),
            },
            { additionalProperties: false },
          ),
          response: {
            200: Type.Object({
              status: Type.Literal("ok"),
              serverTime: Type.String(),
              nextRefreshSeconds: Type.Integer(),
              screenRevision: Type.String(),
              screenId: ScreenIdSchema,
            }),
            401: Type.Object({ error: Type.Literal("Unauthorized") }),
          },
        },
      },
      async (request, reply) => {
        if (!hasValidBearerToken(request.headers.authorization, deviceApiToken)) {
          return reply
            .header("WWW-Authenticate", "Bearer")
            .code(401)
            .send({ error: "Unauthorized" });
        }

        const body = request.body;
        const now = clock().toISOString();
        const values = {
          id: body.deviceId,
          model: body.model,
          firmwareVersion: body.firmwareVersion,
          width: body.width,
          height: body.height,
          lastSeenAt: now,
          lastScreenRevision: body.screenRevision ?? null,
          lastWakeReason: body.wakeReason,
          lastWifiRssi: body.wifiRssi ?? null,
          lastBatteryVoltage: body.batteryVoltage ?? null,
          lastButtonEvent: body.buttonEvent,
          lastDisplayResult: body.displayResult,
          createdAt: now,
          updatedAt: now,
        };

        const screenId = database.raw.transaction(() => {
          const current = screenService.resolveScreenId(storedScreenId(body.deviceId));
          const pressed = body.displayResult === "button";
          const navigated =
            pressed && (body.buttonEvent === "previous" || body.buttonEvent === "next");
          const nextScreenId = navigated
            ? screenService.navigate(current, body.buttonEvent)
            : current;
          const manualValues = {
            ...(pressed ? { manualRequestAt: now } : {}),
            ...(navigated
              ? { screenChangedAt: now, manualHoldUntil: screenService.manualHoldUntil() }
              : {}),
          };

          database.orm
            .insert(devices)
            .values({
              ...values,
              currentScreenId: nextScreenId,
              screenChangedAt: now,
              ...manualValues,
            })
            .onConflictDoUpdate({
              target: devices.id,
              set: {
                model: values.model,
                firmwareVersion: values.firmwareVersion,
                width: values.width,
                height: values.height,
                lastSeenAt: values.lastSeenAt,
                lastScreenRevision: values.lastScreenRevision,
                lastWakeReason: values.lastWakeReason,
                lastWifiRssi: values.lastWifiRssi,
                lastBatteryVoltage: values.lastBatteryVoltage,
                lastButtonEvent: values.lastButtonEvent,
                lastDisplayResult: values.lastDisplayResult,
                currentScreenId: nextScreenId,
                ...manualValues,
                updatedAt: values.updatedAt,
              },
            })
            .run();
          database.orm
            .insert(deviceCheckIns)
            .values({
              id: randomUUID(),
              deviceId: body.deviceId,
              receivedAt: now,
              firmwareVersion: body.firmwareVersion,
              screenRevision: body.screenRevision ?? null,
              wakeReason: body.wakeReason,
              wifiRssi: body.wifiRssi ?? null,
              batteryVoltage: body.batteryVoltage ?? null,
              buttonEvent: body.buttonEvent,
              displayResult: body.displayResult,
            })
            .run();
          return nextScreenId;
        })();

        const artifact = await screenService.getArtifact(screenId);
        return {
          status: "ok" as const,
          serverTime: now,
          nextRefreshSeconds: screenService.nextRefreshSeconds(body.deviceId),
          screenRevision: screenRevision(artifact.checksum, variantFor(body.deviceId)),
          screenId,
        };
      },
    );
  };
}
