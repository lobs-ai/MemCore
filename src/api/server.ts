/**
 * Fastify server factory.
 *
 * `buildServer({ memcore })` returns a Fastify instance with /v1 routes wired
 * to a `MemCore` SDK instance. The factory takes the instance rather than
 * options so embedders/LLM clients can be injected by the caller — the same
 * way the SDK class accepts them.
 */

import { randomUUID } from "node:crypto";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { MemCoreError } from "../errors.js";
import { getLogger } from "../logging.js";
import type { MemCore } from "../memcore.js";
import type { IngestionProducer } from "../queue/producer.js";
import { registerAddRoute } from "./routes/add.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerSearchRoute } from "./routes/search.js";

const logger = getLogger("api.server");

export interface BuildServerOptions {
  memcore: MemCore;
  /**
   * Optional ingestion queue. When present, /v1/add enqueues and returns 202
   * with `pending`. When absent, /v1/add runs ingestion synchronously inside
   * the request and returns 202 with `complete`. SPEC contract is the same
   * either way (202 + a status string).
   */
  producer?: IngestionProducer;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(sensible);

  app.decorate("memcore", opts.memcore);
  app.decorate("producer", opts.producer ?? null);

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    req.log.info(
      {
        requestId: req.id,
        method: req.method,
        url: req.url,
        containerTag: req.headers["x-container-tag"] ?? null,
      },
      "request_received",
    );
  });

  app.setErrorHandler((rawErr, req, reply) => {
    if (rawErr instanceof MemCoreError) {
      logger.warn(
        { requestId: req.id, code: rawErr.code, details: rawErr.details },
        rawErr.message,
      );
      return reply.status(rawErr.httpStatus).send({
        error: { code: rawErr.code, message: rawErr.message, details: rawErr.details },
      });
    }
    const fastifyErr = rawErr as { validation?: unknown; message: string; stack?: string };
    if (fastifyErr.validation) {
      return reply.status(400).send({
        error: {
          code: "validation_error",
          message: fastifyErr.message,
          details: { issues: fastifyErr.validation },
        },
      });
    }
    logger.error(
      { requestId: req.id, err: fastifyErr.message, stack: fastifyErr.stack },
      "unhandled_error",
    );
    return reply.status(500).send({
      error: { code: "internal_error", message: "internal server error", details: {} },
    });
  });

  app.register(
    async (scope) => {
      registerHealthRoute(scope);
      registerAddRoute(scope);
      registerSearchRoute(scope);
      registerProfileRoutes(scope);
    },
    { prefix: "/v1" },
  );

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    memcore: MemCore;
    producer: IngestionProducer | null;
  }
}
