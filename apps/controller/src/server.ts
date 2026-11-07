import type { Server } from "node:http";

import { resolveAppEnvironment } from "./app-mode.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startDeviceListener } from "./listeners.js";

const config = loadConfig(await resolveAppEnvironment(process.env));
const app = await buildApp(config);
let deviceServer: Server | null = null;

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await new Promise<void>((resolve) => {
    if (deviceServer === null) {
      resolve();
    } else {
      deviceServer.close(() => resolve());
    }
  });
  await app.close();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await app.listen({ host: config.host, port: config.port });
if (config.devicePort !== null) {
  deviceServer = await startDeviceListener(app, config.host, config.devicePort);
  app.log.info({ port: config.devicePort }, "Device listener ready");
}
if (config.appMode === "home_assistant") {
  app.log.info("Running as a Home Assistant App");
}
