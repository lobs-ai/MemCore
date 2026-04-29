/**
 * Ingestion orchestration.
 *
 * Phase 2 pipeline: chunk → embed chunks → extract memories per chunk →
 * embed memories → write everything in one transaction. The unit is still a
 * "session" (a conversation or a document); session boundary detection lives
 * with the queue (see `queue/session-boundary.ts`).
 *
 * Stages:
 *  1. Load / flatten input into a single text body.
 *  2. Chunk (token-based fixed split — semantic chunking lands in Phase 3).
 *  3. Embed chunks.
 *  4. For each chunk, run the extractor LLM call. Most return [].
 *  5. Embed all extracted memories in a single batched call.
 *  6. Transactional write: conversations, messages, chunks, memories,
 *     memory_chunks. Conversation is marked complete or failed.
 *
 * Conflict detection (Phase 4), contextual prefixes (Phase 3), and edges
 * (Phase 4) are all out of scope. Memories are written as `status='active'`
 * version 1 — the conflict detector will flip statuses later.
 */

import { createHash } from "node:crypto";
import type postgres from "postgres";

import { vectorLiteral } from "../db/vector.js";
import { EmbeddingError, IngestionError } from "../errors.js";
import type { Embedder } from "../llm/embedder.js";
import { getLogger } from "../logging.js";
import { chunkText } from "./chunker.js";
import {
  EXTRACTION_PROMPT_VERSION,
  type ExtractDeps,
  type ExtractedMemory,
  extractMemories,
} from "./extractor.js";

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
  memoriesWritten: number;
}

export interface IngestDeps {
  sql: postgres.Sql;
  embedder: Embedder;
  chunkOptions: { targetTokens: number; minTokens: number };
  /**
   * Memory extractor configuration. When omitted, ingestion runs in chunk-
   * only mode (Phase 1 behaviour) — useful for tests, fallback when no LLM
   * is configured, or callers that want raw RAG.
   */
  extractor?: ExtractDeps;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function flattenMessages(messages: { role: string; content: string }[]): string {
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
  if (!row) throw new IngestionError(`container '${tag}' missing after upsert`);
  return row;
}

interface ChunkPlan {
  content: string;
  position: number;
  tokenCount: number;
  hash: string;
  vector: number[];
  memories: ExtractedMemory[];
}

export async function ingest(deps: IngestDeps, args: IngestArgs): Promise<IngestResult> {
  const text = args.messages ? flattenMessages(args.messages) : args.content;
  const chunks = chunkText(text, deps.chunkOptions);

  if (chunks.length === 0) {
    return await deps.sql.begin(async (tx) => {
      const container = await getOrCreateContainer(tx, args.containerTag);
      const conv = await upsertConversation(tx, container.id, args, "complete", 0);
      return {
        conversationId: conv.id,
        ingestionStatus: conv.ingestion_status,
        chunksWritten: 0,
        memoriesWritten: 0,
      };
    });
  }

  // Stage: embed chunks.
  const chunkEmbeddings = await deps.embedder.embed({ texts: chunks.map((c) => c.content) });
  if (chunkEmbeddings.vectors.length !== chunks.length) {
    throw new EmbeddingError("embedder returned wrong number of vectors", {
      expected: chunks.length,
      got: chunkEmbeddings.vectors.length,
    });
  }

  // Stage: extract memories per chunk.
  // Run extractions in sequence to keep request rate predictable; the eval
  // suite ingests dozens of cases and burst-fanout on Haiku tends to 429.
  const plans: ChunkPlan[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const vector = chunkEmbeddings.vectors[i];
    if (!vector) throw new EmbeddingError("missing chunk vector", { index: i });
    const memories = deps.extractor
      ? await extractMemoriesSafely(deps.extractor, chunk.content)
      : [];
    plans.push({
      content: chunk.content,
      position: chunk.position,
      tokenCount: chunk.tokenCount,
      hash: contentHash(chunk.content),
      vector,
      memories,
    });
  }

  // Stage: embed memories in one call.
  const flatMemories: { planIdx: number; memory: ExtractedMemory }[] = [];
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    if (!plan) continue;
    for (const m of plan.memories) flatMemories.push({ planIdx: i, memory: m });
  }
  let memoryVectors: number[][] = [];
  if (flatMemories.length > 0) {
    const memoryEmbeddings = await deps.embedder.embed({
      texts: flatMemories.map((m) => m.memory.content),
    });
    if (memoryEmbeddings.vectors.length !== flatMemories.length) {
      throw new EmbeddingError("embedder returned wrong number of memory vectors", {
        expected: flatMemories.length,
        got: memoryEmbeddings.vectors.length,
      });
    }
    memoryVectors = memoryEmbeddings.vectors;
  }

  // Stage: transactional write.
  return await deps.sql.begin(async (tx) => {
    const container = await getOrCreateContainer(tx, args.containerTag);

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
          memoriesWritten: 0,
        };
      }
    }

    const conversation = await upsertConversation(
      tx,
      container.id,
      args,
      "processing",
      args.messages?.length ?? 0,
    );

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

    // Chunks. Insert and capture ids so we can link memory_chunks.
    const chunkIds: (string | null)[] = new Array(plans.length).fill(null);
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      if (!plan) continue;
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO chunks (
          container_id, conversation_id, source_type, source_id, content,
          embedding, content_hash, position, document_date, metadata
        ) VALUES (
          ${container.id}, ${conversation.id}, ${args.sourceType},
          ${args.externalId ?? null}, ${plan.content},
          ${vectorLiteral(plan.vector)}::vector,
          ${plan.hash}, ${plan.position}, ${args.documentDate ?? null},
          ${tx.json({ tokenCount: plan.tokenCount } as never)}
        )
        ON CONFLICT (container_id, content_hash) DO UPDATE
          SET content_hash = EXCLUDED.content_hash
        RETURNING id
      `;
      chunkIds[i] = inserted[0]?.id ?? null;
    }

    // Memories.
    let memoriesWritten = 0;
    const extractorModel = deps.extractor?.model ?? "none";
    for (let m = 0; m < flatMemories.length; m += 1) {
      const entry = flatMemories[m];
      const vector = memoryVectors[m];
      if (!entry || !vector) continue;
      const sourceChunkId = chunkIds[entry.planIdx];
      if (!sourceChunkId) continue;
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO memories (
          container_id, content, embedding, category, document_date,
          confidence, prompt_version, extractor_model
        ) VALUES (
          ${container.id}, ${entry.memory.content},
          ${vectorLiteral(vector)}::vector,
          ${entry.memory.category},
          ${args.documentDate ?? null},
          ${entry.memory.confidence},
          ${EXTRACTION_PROMPT_VERSION},
          ${extractorModel}
        )
        RETURNING id
      `;
      const memoryId = inserted[0]?.id;
      if (!memoryId) continue;
      await tx`
        INSERT INTO memory_chunks (memory_id, chunk_id, relevance)
        VALUES (${memoryId}, ${sourceChunkId}, ${1.0})
        ON CONFLICT (memory_id, chunk_id) DO NOTHING
      `;
      memoriesWritten += 1;
    }

    await tx`
      UPDATE conversations
      SET ingestion_status = 'complete', ingested_at = NOW()
      WHERE id = ${conversation.id}
    `;

    logger.info(
      {
        conversationId: conversation.id,
        chunkCount: plans.length,
        memoryCount: memoriesWritten,
        embeddingModel: chunkEmbeddings.model,
      },
      "ingestion_complete",
    );

    return {
      conversationId: conversation.id,
      ingestionStatus: "complete",
      chunksWritten: plans.length,
      memoriesWritten,
    };
  });
}

async function upsertConversation(
  tx: postgres.TransactionSql | postgres.Sql,
  containerId: string,
  args: IngestArgs,
  status: string,
  messageCount: number,
): Promise<ConversationRow> {
  const rows = await tx<ConversationRow[]>`
    INSERT INTO conversations (
      container_id, external_id, message_count, ingestion_status, metadata
    ) VALUES (
      ${containerId},
      ${args.externalId ?? null},
      ${messageCount},
      ${status},
      ${tx.json(JSON.parse(JSON.stringify(args.metadata ?? {})))}
    )
    RETURNING id, container_id, external_id, ingestion_status
  `;
  const row = rows[0];
  if (!row) throw new IngestionError("conversation insert returned no row");
  return row;
}

async function extractMemoriesSafely(
  extractor: ExtractDeps,
  chunkContent: string,
): Promise<ExtractedMemory[]> {
  try {
    return await extractMemories(extractor, { chunkContent });
  } catch (err) {
    // An extractor failure on one chunk should not block the whole session.
    // The chunk is still written and remains searchable as raw RAG; the
    // memory layer just misses this entry. Better to land 19/20 memories
    // than zero.
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "extractor_failed_skipping_chunk",
    );
    return [];
  }
}
