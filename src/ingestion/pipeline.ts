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
  type ConflictDecision,
  type DetectConflictsDeps,
  decisionToRelationship,
  detectConflicts,
  pgSimilarMemoryFinder,
} from "./conflict-detector.js";
import { type ContextualizeDeps, contextualizeChunks } from "./contextualizer.js";
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

export interface IngestedMemory {
  id: string;
  content: string;
  category: string;
  status: string;
  confidence: number;
}

export interface IngestResult {
  conversationId: string;
  ingestionStatus: string;
  chunksWritten: number;
  memoriesWritten: number;
  /** Edges written by the conflict detector (updates / extends / derives / contradicts). */
  edgesWritten: number;
  /** Existing memories whose status flipped to `superseded` because a new memory updated them. */
  memoriesSuperseded: number;
  /** Candidate memories the conflict detector classified as duplicates and skipped. */
  duplicatesSkipped: number;
  /**
   * Memory rows the pipeline inserted (excluding skipped duplicates). Order
   * matches the order in which they were classified. Callers who need to
   * reference the just-written rows (e.g. a typed-memory agent that wants the
   * id back from `add({ extract: false })`) get them here without a follow-up
   * query.
   */
  memories: IngestedMemory[];
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
  /**
   * Contextualizer configuration. When present, each chunk gets a 1–2 sentence
   * prefix generated against the full session and embeds use `prefix + content`.
   * When omitted, chunks are embedded as raw content (Phase 1/2 behaviour).
   */
  contextualizer?: ContextualizeDeps;
  /**
   * Conflict detection configuration. When present, each candidate memory is
   * classified against existing memories (top-K vector similarity), edges are
   * written, and superseded memories' status is flipped. When omitted, every
   * candidate is inserted as `new` with no edges (Phase 2/3 behaviour).
   *
   * Pass either an LLMClient + model and we'll use the default Postgres
   * similarity finder, or override `findSimilar` for custom retrieval.
   */
  conflictDetector?: Omit<DetectConflictsDeps, "findSimilar"> &
    Partial<Pick<DetectConflictsDeps, "findSimilar">>;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function flattenMessages(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

/**
 * Best-effort container-id lookup before the write transaction. Returns null
 * for first-ingest containers (in which case no existing memories exist so
 * conflict detection has nothing to compare against anyway).
 */
async function resolveContainerId(sql: postgres.Sql, tag: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM containers WHERE tag = ${tag} LIMIT 1
  `;
  return rows[0]?.id ?? null;
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
  contextualPrefix: string | null;
  vector: number[];
  memories: ExtractedMemory[];
}

function chunkEmbeddingInput(content: string, contextualPrefix: string | null): string {
  return contextualPrefix ? `${contextualPrefix}\n\n${content}` : content;
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
        edgesWritten: 0,
        memoriesSuperseded: 0,
        duplicatesSkipped: 0,
        memories: [],
      };
    });
  }

  // Stage: contextualize chunks. Skipped when no contextualizer is configured;
  // also skipped per-chunk for very short chunks (<50 tokens). Failures degrade
  // to a null prefix so one bad LLM call doesn't lose the whole session.
  let prefixes: (string | null)[] = new Array(chunks.length).fill(null);
  if (deps.contextualizer) {
    prefixes = await contextualizeChunks(deps.contextualizer, {
      sessionText: text,
      chunks: chunks.map((c) => ({ content: c.content, tokenCount: c.tokenCount })),
    });
  }

  // Stage: embed chunks. Embedding input is `prefix + content` when we have a
  // prefix — that's the whole point of contextual retrieval.
  const chunkEmbeddings = await deps.embedder.embed({
    texts: chunks.map((c, i) => chunkEmbeddingInput(c.content, prefixes[i] ?? null)),
  });
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
      ? await extractMemoriesSafely(deps.extractor, chunk.content, args.documentDate)
      : [];
    plans.push({
      content: chunk.content,
      position: chunk.position,
      tokenCount: chunk.tokenCount,
      hash: contentHash(chunk.content),
      contextualPrefix: prefixes[i] ?? null,
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

  // Stage: conflict detection. Runs before the write transaction so the
  // similarity search reads memories committed by prior sessions. We resolve
  // the container id against the live pool first, then classify each candidate.
  // When no detector is configured every candidate is treated as `new`.
  const conflictContainerId = await resolveContainerId(deps.sql, args.containerTag);
  const conflictDecisions: Map<number, ConflictDecision> = new Map();
  if (deps.conflictDetector && flatMemories.length > 0 && conflictContainerId) {
    const candidates = flatMemories.map((entry, idx) => ({
      index: idx,
      content: entry.memory.content,
      category: entry.memory.category,
      vector: memoryVectors[idx] ?? [],
    }));
    const detectorDeps = {
      ...deps.conflictDetector,
      findSimilar: deps.conflictDetector.findSimilar ?? pgSimilarMemoryFinder(deps.sql),
    };
    const decisions = await detectConflicts(detectorDeps, {
      containerId: conflictContainerId,
      candidates,
    });
    for (const d of decisions) conflictDecisions.set(d.index, d);
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
          edgesWritten: 0,
          memoriesSuperseded: 0,
          duplicatesSkipped: 0,
          memories: [],
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
          contextual_prefix, embedding, content_hash, position, document_date, metadata
        ) VALUES (
          ${container.id}, ${conversation.id}, ${args.sourceType},
          ${args.externalId ?? null}, ${plan.content},
          ${plan.contextualPrefix},
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

    // Memories. Honour conflict decisions (Phase 4):
    //   - duplicate: skip insert; link the existing memory to the source chunk.
    //   - update:    insert the new memory; flip target's status to superseded;
    //                write an `updates` edge.
    //   - extend / derive / contradicts: insert + write the corresponding edge.
    //   - new (or no detector): insert; no edge.
    let memoriesWritten = 0;
    let edgesWritten = 0;
    let memoriesSuperseded = 0;
    let duplicatesSkipped = 0;
    const insertedMemories: IngestedMemory[] = [];
    const supersededTargets = new Set<string>();
    const extractorModel = deps.extractor?.model ?? "none";
    for (let m = 0; m < flatMemories.length; m += 1) {
      const entry = flatMemories[m];
      const vector = memoryVectors[m];
      if (!entry || !vector) continue;
      const sourceChunkId = chunkIds[entry.planIdx];
      if (!sourceChunkId) continue;

      const decision = conflictDecisions.get(m);

      // Duplicate: skip the insert, but still link the existing memory to the
      // chunk so source-chunk joins surface this conversation as evidence.
      if (decision?.decision === "duplicate" && decision.targetId) {
        await tx`
          INSERT INTO memory_chunks (memory_id, chunk_id, relevance)
          VALUES (${decision.targetId}, ${sourceChunkId}, ${1.0})
          ON CONFLICT (memory_id, chunk_id) DO NOTHING
        `;
        duplicatesSkipped += 1;
        continue;
      }

      const inserted = await tx<{ id: string; status: string }[]>`
        INSERT INTO memories (
          container_id, content, embedding, category, document_date,
          event_date, event_date_precision,
          confidence, prompt_version, extractor_model
        ) VALUES (
          ${container.id}, ${entry.memory.content},
          ${vectorLiteral(vector)}::vector,
          ${entry.memory.category},
          ${args.documentDate ?? null},
          ${entry.memory.eventDate ?? null},
          ${entry.memory.eventDatePrecision},
          ${entry.memory.confidence},
          ${EXTRACTION_PROMPT_VERSION},
          ${extractorModel}
        )
        RETURNING id, status
      `;
      const insertedRow = inserted[0];
      if (!insertedRow) continue;
      const memoryId = insertedRow.id;
      await tx`
        INSERT INTO memory_chunks (memory_id, chunk_id, relevance)
        VALUES (${memoryId}, ${sourceChunkId}, ${1.0})
        ON CONFLICT (memory_id, chunk_id) DO NOTHING
      `;
      memoriesWritten += 1;
      insertedMemories.push({
        id: memoryId,
        content: entry.memory.content,
        category: entry.memory.category,
        status: insertedRow.status,
        confidence: entry.memory.confidence,
      });

      if (decision?.targetId) {
        const relType = decisionToRelationship(decision.decision);
        if (relType) {
          const edgeRow = await tx<{ id: string }[]>`
            INSERT INTO edges (
              source_memory_id, target_memory_id, relationship_type, confidence
            ) VALUES (
              ${memoryId}, ${decision.targetId}, ${relType}, ${decision.confidence}
            )
            ON CONFLICT (source_memory_id, target_memory_id, relationship_type)
              DO NOTHING
            RETURNING id
          `;
          if (edgeRow[0]) edgesWritten += 1;

          if (relType === "updates" && !supersededTargets.has(decision.targetId)) {
            await tx`
              UPDATE memories
              SET status = 'superseded', updated_at = NOW()
              WHERE id = ${decision.targetId} AND status = 'active'
            `;
            supersededTargets.add(decision.targetId);
            memoriesSuperseded += 1;
          }
        }
      }
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
        edgesWritten,
        memoriesSuperseded,
        duplicatesSkipped,
        embeddingModel: chunkEmbeddings.model,
      },
      "ingestion_complete",
    );

    return {
      conversationId: conversation.id,
      ingestionStatus: "complete",
      chunksWritten: plans.length,
      memoriesWritten,
      edgesWritten,
      memoriesSuperseded,
      duplicatesSkipped,
      memories: insertedMemories,
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
  documentDate?: Date,
): Promise<ExtractedMemory[]> {
  try {
    return await extractMemories(
      extractor,
      documentDate ? { chunkContent, documentDate } : { chunkContent },
    );
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
