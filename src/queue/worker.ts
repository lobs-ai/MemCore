/**
 * Ingestion worker.
 *
 * Pulls jobs from the BullMQ queue and runs them through `MemCore.add()`
 * (for "ingest" jobs) or the equivalent pipeline against an existing
 * conversation (for "ingest_session" jobs from the boundary scanner).
 *
 * Run as a separate process: `pnpm worker` / `node dist/queue/main.js`.
 *
 * On failure the job is retried per the producer's `attempts`/`backoff`
 * config; if all retries fail the conversation is marked `failed` with the
 * error in metadata so it surfaces in the API.
 */

import { type Job, Worker } from "bullmq";
import type postgres from "postgres";

import { getLogger } from "../logging.js";
import type { MemCore } from "../memcore.js";
import { makeRedisConnection } from "./connection.js";
import {
  type IngestJobData,
  type IngestSessionJobData,
  type JobName,
  QUEUE_NAME,
} from "./types.js";

const logger = getLogger("queue.worker");

export interface WorkerOptions {
  redisUrl: string;
  memcore: MemCore;
  /**
   * For "ingest_session" jobs the worker reaches past `MemCore.add()` and
   * loads/replays an existing conversation. We pass the SDK's internal sql
   * for that one path so the boundary worker can read messages directly.
   */
  sql: postgres.Sql;
  concurrency?: number;
}

export function startIngestionWorker(opts: WorkerOptions): Worker {
  const connection = makeRedisConnection(opts.redisUrl);

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const name = job.name as JobName;
      if (name === "ingest") {
        return handleIngest(opts.memcore, job as Job<IngestJobData>);
      }
      if (name === "ingest_session") {
        return handleIngestSession(opts.memcore, opts.sql, job as Job<IngestSessionJobData>);
      }
      throw new Error(`unknown job name: ${job.name}`);
    },
    { connection, concurrency: opts.concurrency ?? 2 },
  );

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, name: job.name, result }, "job_complete");
  });
  worker.on("failed", (job, err) => {
    logger.warn(
      { jobId: job?.id, name: job?.name, err: err.message, attempts: job?.attemptsMade },
      "job_failed",
    );
  });

  return worker;
}

async function handleIngest(memcore: MemCore, job: Job<IngestJobData>): Promise<unknown> {
  const data = job.data;
  return memcore.add({
    containerTag: data.containerTag,
    content: data.content || undefined,
    messages: data.messages,
    sourceType: data.sourceType,
    externalId: data.externalId,
    documentDate: data.documentDate ? new Date(data.documentDate) : undefined,
    metadata: data.metadata,
  });
}

async function handleIngestSession(
  memcore: MemCore,
  sql: postgres.Sql,
  job: Job<IngestSessionJobData>,
): Promise<unknown> {
  const conversationId = job.data.conversationId;

  const convRows = await sql<
    {
      id: string;
      container_id: string;
      external_id: string | null;
      ingestion_status: string;
      metadata: Record<string, unknown>;
    }[]
  >`
    SELECT id, container_id, external_id, ingestion_status, metadata
    FROM conversations WHERE id = ${conversationId} LIMIT 1
  `;
  const conv = convRows[0];
  if (!conv) {
    logger.warn({ conversationId }, "conversation_missing");
    return { skipped: true };
  }
  if (conv.ingestion_status === "complete") {
    return { skipped: true, reason: "already_complete" };
  }

  const containerRows = await sql<{ tag: string }[]>`
    SELECT tag FROM containers WHERE id = ${conv.container_id} LIMIT 1
  `;
  const container = containerRows[0];
  if (!container) throw new Error(`container ${conv.container_id} missing`);

  const messageRows = await sql<{ role: string; content: string }[]>`
    SELECT role, content FROM messages
    WHERE conversation_id = ${conv.id}
    ORDER BY position ASC
  `;

  // We don't re-stage the conversation row: handleIngestSession is for
  // conversations that were appended to via direct DB writes (not /v1/add).
  // For the queue-driven /v1/add path, "ingest" creates the row from scratch.
  // To keep the pipeline single-shape, we mark the existing row failed if
  // re-ingest fails, complete on success.
  try {
    const result = await memcore.add({
      containerTag: container.tag,
      messages: messageRows.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
      externalId: conv.external_id ?? `re-ingest-${conv.id}`,
      metadata: { ...conv.metadata, reingestOf: conv.id },
    });
    return result;
  } catch (err) {
    await sql`
      UPDATE conversations
      SET ingestion_status = 'failed',
          metadata = metadata || ${sql.json({
            error: err instanceof Error ? err.message : String(err),
          } as never)}
      WHERE id = ${conv.id}
    `;
    throw err;
  }
}
