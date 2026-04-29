/**
 * Profile API (Phase 6).
 *
 *   POST /v1/profiles/build  — generate (or regenerate) the profile for a
 *                              container. Synchronous. Returns the new row.
 *   GET  /v1/profiles/:tag   — fetch the current profile.
 *
 * Generation is intentionally synchronous in the request: it takes one LLM
 * call, the request shape mirrors the SDK's `MemCore.buildProfile()`, and
 * batching multiple builds into a queue is the caller's job (a cron, a
 * scheduler, a BullMQ repeat job — there's no one-size-fits-all worker
 * shape we want to bake into the server).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const BuildRequest = z.object({
  container_tag: z.string().min(1),
});

const ProfileResponse = z.object({
  id: z.string().uuid(),
  container_tag: z.string(),
  content: z.string(),
  source_memory_count: z.number(),
  version: z.number(),
  prompt_version: z.string(),
  generator_model: z.string(),
  generated_at: z.string().datetime(),
});

const NotFoundResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()),
  }),
});

export function registerProfileRoutes(app: FastifyInstance): void {
  app.route({
    method: "POST",
    url: "/profiles/build",
    schema: {
      body: BuildRequest,
      response: { 200: ProfileResponse, 404: NotFoundResponse },
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof BuildRequest>;
      const profile = await app.memcore.buildProfile({ containerTag: body.container_tag });
      if (!profile) {
        return reply.status(404).send({
          error: {
            code: "not_found",
            message: "no active memories for container, or no LLM client configured",
            details: { container_tag: body.container_tag },
          },
        });
      }
      return reply.send({
        id: profile.id,
        container_tag: body.container_tag,
        content: profile.content,
        source_memory_count: profile.sourceMemoryCount,
        version: profile.version,
        prompt_version: profile.promptVersion,
        generator_model: profile.generatorModel,
        generated_at: profile.generatedAt.toISOString(),
      });
    },
  });

  app.route({
    method: "GET",
    url: "/profiles/:container_tag",
    schema: {
      params: z.object({ container_tag: z.string().min(1) }),
      response: { 200: ProfileResponse, 404: NotFoundResponse },
    },
    handler: async (req, reply) => {
      const params = req.params as { container_tag: string };
      const profile = await app.memcore.getProfile({ containerTag: params.container_tag });
      if (!profile) {
        return reply.status(404).send({
          error: {
            code: "not_found",
            message: "no profile for container",
            details: { container_tag: params.container_tag },
          },
        });
      }
      return reply.send({
        id: profile.id,
        container_tag: params.container_tag,
        content: profile.content,
        source_memory_count: profile.sourceMemoryCount,
        version: profile.version,
        prompt_version: profile.promptVersion,
        generator_model: profile.generatorModel,
        generated_at: profile.generatedAt.toISOString(),
      });
    },
  });
}
