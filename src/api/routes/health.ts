/**
 * GET /v1/health
 *
 * Returns 200 with `{status, db}` when the database is reachable, 503
 * otherwise. Used by container orchestrators and uptime checks.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["ok", "down"]),
});

export function registerHealthRoute(app: FastifyInstance): void {
  app.route({
    method: "GET",
    url: "/health",
    schema: {
      response: { 200: HealthResponse, 503: HealthResponse },
    },
    handler: async (_req, reply) => {
      try {
        const ok = await app.memcore.ping();
        if (ok) return reply.send({ status: "ok", db: "ok" });
      } catch (err) {
        reply.log.warn({ err: (err as Error).message }, "health_db_failed");
      }
      return reply.status(503).send({ status: "degraded", db: "down" });
    },
  });
}
