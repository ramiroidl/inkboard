import { createServer, type IncomingMessage, type Server } from "node:http";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ControllerConfig } from "./config.js";

const DEVICE_LISTENER = Symbol("inkboard.deviceListener");

type MarkedRequest = IncomingMessage & { [DEVICE_LISTENER]?: true };

/** Paths the device listener serves. Everything else there is hidden. */
const DEVICE_PATHS = ["/api/v1/device/", "/health/"];

function pathOf(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

/** Strips the IPv4-mapped IPv6 prefix so `::ffff:172.30.32.2` matches `172.30.32.2`. */
export function normalizeAddress(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/i, "");
}

/**
 * Enforces listener roles:
 * - the device listener answers only device and health endpoints;
 * - when `adminAllowedAddresses` is set, the main listener answers only those addresses
 *   (inside the App, the Supervisor's authenticated ingress proxy), except health checks.
 */
export function listenerAccessHook(config: ControllerConfig) {
  const allowed = config.adminAllowedAddresses?.map(normalizeAddress) ?? null;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = pathOf(request.url);
    if ((request.raw as MarkedRequest)[DEVICE_LISTENER] === true) {
      if (!DEVICE_PATHS.some((prefix) => path.startsWith(prefix))) {
        await reply.code(404).send({ error: "Not found" });
      }
      return;
    }
    if (
      allowed !== null &&
      !path.startsWith("/health/") &&
      !allowed.includes(normalizeAddress(request.socket.remoteAddress))
    ) {
      await reply.code(403).send({ error: "Forbidden" });
    }
  };
}

/** Starts the device-only listener, routing requests through the same Fastify app. */
export async function startDeviceListener(
  app: FastifyInstance,
  host: string,
  port: number,
): Promise<Server> {
  await app.ready();
  const server = createServer((request, response) => {
    (request as MarkedRequest)[DEVICE_LISTENER] = true;
    app.routing(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
