/**
 * POST /v1/add — write content into memory.
 *
 * Phase 1 runs ingestion synchronously inside the request handler (chunk →
 * embed → write). SPEC.md describes the full async session-scoped pipeline;
 * that lives behind a queue from Phase 2 onwards. The handler still returns
 * 202 to keep the contract stable across phases.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const AddMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

const AddRequest = z
  .object({
    container_tag: z.string().min(1),
    content: z.string().optional(),
    messages: z.array(AddMessage).optional(),
    source_type: z.string().default("conversation"),
    external_id: z.string().optional(),
    document_date: z.coerce.date().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => v.content != null || v.messages != null, {
    message: "either 'content' or 'messages' is required",
  })
  .refine((v) => !(v.content != null && v.messages != null), {
    message: "provide only one of 'content' or 'messages'",
  });

const AddResponse = z.object({
  id: z.string().uuid(),
  ingestion_status: z.string(),
});

export function registerAddRoute(app: FastifyInstance): void {
  app.route({
    method: "POST",
    url: "/add",
    schema: {
      body: AddRequest,
      response: { 202: AddResponse },
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof AddRequest>;
      const result = await app.memcore.add({
        containerTag: body.container_tag,
        content: body.content,
        messages: body.messages,
        sourceType: body.source_type,
        externalId: body.external_id,
        documentDate: body.document_date,
        metadata: body.metadata,
      });
      return reply.status(202).send({
        id: result.conversationId,
        ingestion_status: result.ingestionStatus,
      });
    },
  });
}
