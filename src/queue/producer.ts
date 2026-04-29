/**
 * Ingestion queue producer.
 *
 * The HTTP route and the SDK class both go through this when configured.
 * It owns its own ioredis connection. Call `close()` on shutdown.
 *
 * Phase 2 ships the producer + worker. When the queue is wired in, the
 * /v1/add path enqueues a job and returns 202 with `ingestion_status:
 * "pending"` immediately — the worker writes the conversation, chunks, and
 * memories asynchronously.
 */

import { Queue } from "bullmq";

import { type Redis, makeRedisConnection } from "./connection.js";
import { type IngestJobData, type IngestSessionJobData, QUEUE_NAME } from "./types.js";

export interface ProducerOptions {
  redisUrl: string;
}

export class IngestionProducer {
  private readonly queue: Queue;
  private readonly connection: Redis;

  constructor(opts: ProducerOptions) {
    this.connection = makeRedisConnection(opts.redisUrl);
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
  }

  async enqueueIngest(data: IngestJobData): Promise<string> {
    const job = await this.queue.add("ingest", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return job.id ?? "";
  }

  async enqueueSession(data: IngestSessionJobData): Promise<string> {
    const job = await this.queue.add("ingest_session", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return job.id ?? "";
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
