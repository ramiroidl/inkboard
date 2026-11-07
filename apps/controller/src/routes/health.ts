import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { ArtifactService } from "../artifacts/artifact-service.js";
import type { InkboardDatabase } from "../db/database.js";

const baseHealthSchema = Type.Object({
  status: Type.Literal("ok"),
  service: Type.Literal("inkboard-controller"),
  version: Type.String(),
});

export function healthRoutes(
  database: InkboardDatabase,
  artifactService: ArtifactService,
  version: string,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/health/live",
      {
        schema: {
          response: {
            200: baseHealthSchema,
          },
        },
      },
      async () => ({
        status: "ok" as const,
        service: "inkboard-controller" as const,
        version,
      }),
    );

    app.get(
      "/health/ready",
      {
        schema: {
          response: {
            200: Type.Intersect([
              baseHealthSchema,
              Type.Object({
                database: Type.Literal("ready"),
                artifactStore: Type.Literal("ready"),
              }),
            ]),
          },
        },
      },
      async () => {
        database.assertReady();
        artifactService.assertReady();
        return {
          status: "ok" as const,
          service: "inkboard-controller" as const,
          version,
          database: "ready" as const,
          artifactStore: "ready" as const,
        };
      },
    );
  };
}
