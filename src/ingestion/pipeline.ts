/**
 * Ingestion orchestration. Phase 1 is a thin synchronous pipeline.
 *
 * Phase 1 deliberately runs ingestion inline inside the request/SDK call:
 * chunk → embed → write. SPEC.md § Ingestion pipeline describes the full
 * async, session-scoped pipeline (chunking → contextualizing → extraction →
 * conflict detection → write); none of that exists yet. The simplest possible
 * inline version is the right baseline to measure later phases against.
 *
 * When Phase 2 lands (memory extraction) and Phase 3 lands (contextualizer +
 * hybrid search), this module grows into the orchestrator that SPEC describes.
 * At that point /v1/add and MemCore.add() enqueue work onto Redis/RQ instead
 * of calling these helpers directly.
 */

import { createHash } from "node:crypto";
import type postgres from "postgres";

import { vectorLiteral } from "../db/vector.js";
import { EmbeddingError } from "../errors.js";
import type { Embedder } from "../llm/embedder.js";
import { getLogger } from "../logging.js";
import { chunkText } from "./chunker.js";

const logger = getLogger("ingestion.pipeline");

export interface ContainerRow {
  id: string;
  tag: string;
}

export interface ConversationRow {
  id: string;
  container_id: string;
  external_id: string | null;
  ingestion_status: string;
}

export interface IngestArgs {
  containerTag: string;
  sourceType: string;
  content: string;
  externalId?: string;
  documentDate?: Date;
  messages?: { role: string; content: string }[];
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  conversationId: string;
  ingestionStatus: string;
  chunksWritten: number;
}

export interface IngestDeps {
  sql: postgres.Sql;
  embedder: Embedder;
  chunkOptions: { targetTokens: number; minTokens: number };
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function flattenMessages(messages: { role: string; content: string }[]): string {
  // Phase 1: concatenate messages into one document for chunking. Real
  // session-aware chunking lands in Phase 3. Until then, role prefixes
  // preserve enough turn structure for naive vector search to work.
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

async function getOrCreateContainer(
  sql: postgres.TransactionSql | postgres.Sql,
  tag: string,
): Promise<ContainerRow> {
  const rows = await sql<ContainerRow[]>`
    INSERT INTO containers (tag)
    VALUES (${tag})
    ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag
    RETURNING id, tag
  `;
  const row = rows[0];
  if (!row) throw new Error(`container '${tag}' missing after upsert`);
  return row;
}

export async function ingest(deps: IngestDeps, args: IngestArgs): Promise<IngestResult> {
  const text = args.messages ? flattenMessages(args.messages) : args.content;
  return await deps.sql.begin(async (tx) => {
    const container = await getOrCreateContainer(tx, args.containerTag);

    // Idempotency: re-adding the same external_id is a no-op.
    if (args.externalId) {
      const existing = await tx<ConversationRow[]>`
        SELECT id, container_id, external_id, ingestion_status
        FROM conversations
        WHERE container_id = ${container.id} AND external_id = ${args.externalId}
        LIMIT 1
      `;
      if (existing[0]) {
        return {
          conversationId: existing[0].id,
          ingestionStatus: existing[0].ingestion_status,
          chunksWritten: 0,
        };
      }
    }

    const conv = await tx<ConversationRow[]>`
      INSERT INTO conversations (
        container_id, external_id, message_count, ingestion_status, metadata
      ) VALUES (
        ${container.id},
        ${args.externalId ?? null},
        ${args.messages?.length ?? 0},
        'processing',
        ${tx.json(JSON.parse(JSON.stringify(args.metadata ?? {})))}
      )
      RETURNING id, container_id, external_id, ingestion_status
    `;
    const conversation = conv[0];
    if (!conversation) throw new Error("conversation insert returned no row");

    if (args.messages?.length) {
      const rows = args.messages.map((m, position) => ({
        conversation_id: conversation.id,
        role: m.role,
        content: m.content,
        position,
      }));
      await tx`
        INSERT INTO messages ${tx(rows, "conversation_id", "role", "content", "position")}
      `;
    }

    const chunks = chunkText(text, deps.chunkOptions);
    if (chunks.length === 0) {
      await tx`
        UPDATE conversations
        SET ingestion_status = 'complete', ingested_at = NOW()
        WHERE id = ${conversation.id}
      `;
      return {
        conversationId: conversation.id,
        ingestionStatus: "complete",
        chunksWritten: 0,
      };
    }

    const embeddings = await deps.embedder.embed({ texts: chunks.map((c) => c.content) });
    if (embeddings.vectors.length !== chunks.length) {
      throw new EmbeddingError("embedder returned wrong number of vectors", {
        expected: chunks.length,
        got: embeddings.vectors.length,
      });
    }

    // Bulk insert with one round trip. We render the embedding as a pgvector
    // literal because postgres.js doesn't let us mix tagged-template arrays
    // and JSON bulk-insert in a single statement.
    const chunkRows = chunks.map((c, i) => {
      const vector = embeddings.vectors[i];
      if (!vector) throw new EmbeddingError("missing vector for chunk", { index: i });
      return {
        container_id: container.id,
        conversation_id: conversation.id,
        source_type: args.sourceType,
        source_id: args.externalId ?? null,
        content: c.content,
        embedding: vectorLiteral(vector),
        content_hash: contentHash(c.content),
        position: c.position,
        document_date: args.documentDate ?? null,
        metadata: { tokenCount: c.tokenCount },
      };
    });

    for (const row of chunkRows) {
      await tx`
        INSERT INTO chunks (
          container_id, conversation_id, source_type, source_id, content,
          embedding, content_hash, position, document_date, metadata
        ) VALUES (
          ${row.container_id}, ${row.conversation_id}, ${row.source_type},
          ${row.source_id}, ${row.content}, ${row.embedding}::vector,
          ${row.content_hash}, ${row.position}, ${row.document_date},
          ${tx.json(JSON.parse(JSON.stringify(row.metadata)))}
        )
        ON CONFLICT (container_id, content_hash) DO NOTHING
      `;
    }

    await tx`
      UPDATE conversations
      SET ingestion_status = 'complete', ingested_at = NOW()
      WHERE id = ${conversation.id}
    `;

    logger.info(
      {
        conversationId: conversation.id,
        chunkCount: chunks.length,
        embeddingModel: embeddings.model,
      },
      "ingestion_complete",
    );

    return {
      conversationId: conversation.id,
      ingestionStatus: "complete",
      chunksWritten: chunks.length,
    };
  });
}
