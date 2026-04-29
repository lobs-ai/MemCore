/**
 * GET /v1/health
 *
 * Returns 200 with `{status, db, version}` when the database is reachable,
 * 503 otherwise. The `version` field is the SDK version (sourced from
 * `package.json`) so deployments can be matched to a release without an
 * extra endpoint.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["ok", "down"]),
  version: z.string(),
});

export function registerHealthRoute(app: FastifyInstance): void {
  app.route({
    method: "GET",
    url: "/health",
    schema: {
      response: { 200: HealthResponse, 503: HealthResponse },
    },
    handler: async (_req, reply) => {
      const version = app.memcore.version;
      try {
        const ok = await app.memcore.ping();
        if (ok) return reply.send({ status: "ok", db: "ok", version });
      } catch (err) {
        reply.log.warn({ err: (err as Error).message }, "health_db_failed");
      }
      return reply.status(503).send({ status: "degraded", db: "down", version });
    },
  });
}
