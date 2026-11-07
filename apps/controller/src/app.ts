import { access } from "node:fs/promises";

import fastifyStatic from "@fastify/static";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";

import { ArtifactService } from "./artifacts/artifact-service.js";
import { CalendarService } from "./calendar/calendar-service.js";
import { HomeAssistantStateClient } from "./integrations/home-assistant-states.js";
import { JsonFetchCache } from "./integrations/http-json.js";
import { MicrosoftGraphTodoClient } from "./integrations/microsoft-graph-todo.js";
import { MicrosoftIdentityClient } from "./integrations/microsoft-identity.js";
import { SettingsStore } from "./db/settings-store.js";
import { DisplaySettings } from "./devices/display-settings.js";
import { SecretBox } from "./security/secret-box.js";
import { TodoService } from "./todo/todo-service.js";
import { microsoftTodoRoutes } from "./routes/microsoft-todo.js";
import { BackupService } from "./backup/backup-service.js";
import { backupRoutes } from "./routes/backup.js";
import { createWidgetRegistry } from "./widgets/registry.js";
import type { WidgetDefinition } from "./widgets/types.js";
import { ScreenService } from "./screens/screen-service.js";
import type { ControllerConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { adminRoutes } from "./routes/admin.js";
import { developmentRoutes } from "./routes/development.js";
import { deviceRoutes } from "./routes/device.js";
import { healthRoutes } from "./routes/health.js";
import { listenerAccessHook } from "./listeners.js";

export const SERVICE_VERSION = "0.1.0";

export interface BuildAppOptions {
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  /** Widgets registered in addition to the discovered `widgets/<type>` folders. */
  extraWidgets?: WidgetDefinition[];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export async function buildApp(
  config: ControllerConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
        censor: "[REDACTED]",
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();
  app.setValidatorCompiler(TypeBoxValidatorCompiler);
  app.addHook("onRequest", listenerAccessHook(config));

  const database = await openDatabase(config);
  const artifactService = new ArtifactService(config, database);
  await artifactService.initialize();
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const calendarService = new CalendarService(
    config,
    artifactService,
    database,
    fetchImplementation,
    now,
    (error) => {
      app.log.warn({ error: error.message }, "Home Assistant calendar refresh failed");
    },
  );
  await calendarService.initialize();
  const stateClient =
    config.homeAssistant === null
      ? null
      : new HomeAssistantStateClient(config.homeAssistant, fetchImplementation, now);
  const widgetRegistry = await createWidgetRegistry(options.extraWidgets);
  const todoService = new TodoService(
    config,
    artifactService,
    new SettingsStore(database, now),
    await SecretBox.create(config.dataDirectory, config.secretKey),
    new MicrosoftIdentityClient(fetchImplementation, now),
    new MicrosoftGraphTodoClient(fetchImplementation),
    now,
    (error) => {
      app.log.warn({ error: error.message }, "Microsoft To Do refresh failed");
    },
  );
  await todoService.initialize();
  const displaySettings = new DisplaySettings(new SettingsStore(database, now));
  const screenService = new ScreenService(
    database,
    calendarService,
    artifactService,
    stateClient,
    config.timeZone,
    widgetRegistry,
    new JsonFetchCache(fetchImplementation, now),
    now,
    todoService,
  );

  app.addHook("onClose", async () => {
    database.close();
  });

  await app.register(healthRoutes(database, artifactService, SERVICE_VERSION));
  await app.register(
    adminRoutes(SERVICE_VERSION, database, calendarService, screenService, widgetRegistry, {
      stateClient,
      appMode: config.appMode,
      devicePort: config.devicePort,
      deviceApiToken: config.deviceApiToken,
      displaySettings,
    }),
  );
  await app.register(microsoftTodoRoutes(todoService));
  await app.register(
    backupRoutes(new BackupService(screenService, calendarService, todoService, now)),
  );
  await app.register(
    deviceRoutes(screenService, database, config.deviceApiToken, now, displaySettings),
  );
  if (config.enableDevelopmentRoutes) {
    await app.register(developmentRoutes(artifactService));
  }

  if (await directoryExists(config.webRoot)) {
    await app.register(fastifyStatic, {
      root: config.webRoot,
      prefix: "/",
    });
  }

  return app;
}
