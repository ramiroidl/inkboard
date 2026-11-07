import { readFile } from "node:fs/promises";

import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { ArtifactService } from "../artifacts/artifact-service.js";

export function developmentRoutes(artifactService: ArtifactService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/api/v1/development/orientation.bmp", async (request, reply) => {
      const artifact = await artifactService.getOrientationArtifact();
      const etag = `"sha256:${artifact.checksum}"`;
      if (request.headers["if-none-match"] === etag) {
        return reply.code(304).send();
      }

      const bmp = await readFile(artifact.filePath);
      return reply
        .header("ETag", etag)
        .header("Cache-Control", "private, max-age=0, must-revalidate")
        .header("X-Screen-Revision", `sha256:${artifact.checksum}`)
        .type("image/bmp")
        .send(bmp);
    });
  };
}
