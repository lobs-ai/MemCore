/**
 * Worker entry point. `pnpm worker` (tsx) or `node dist/queue/main.js`.
 *
 * Builds a MemCore from env, starts a BullMQ worker against the same queue
 * the API server enqueues to, and runs a periodic session-boundary scan.
 * Graceful shutdown closes the worker, the producer, the boundary timer,
 * and the SDK pool.
 */

import postgres from "postgres";

import { getSettings } from "../config.js";
import { getLogger } from "../logging.js";
import { MemCore } from "../memcore.js";
import { IngestionProducer } from "./producer.js";
import { scanForBoundaries } from "./session-boundary.js";
import { startIngestionWorker } from "./worker.js";

const logger = getLogger("queue.main");
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const settings = getSettings();

  const memcore = new MemCore({
    databaseUrl: settings.databaseUrl,
    openaiApiKey: settings.openaiApiKey,
    embeddingApiKey: settings.embeddingApiKey,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDim: settings.embeddingDim,
    extractionModel: settings.extractionModel,
    contextualizerModel: settings.contextualizerModel,
    cohereApiKey: settings.cohereApiKey,
    chunkMaxTokens: settings.chunkMaxTokens,
    chunkMinTokens: settings.chunkMinTokens,
  });

  const sql = postgres(settings.databaseUrl, { onnotice: () => {} });
  const producer = new IngestionProducer({ redisUrl: settings.redisUrl });
  const worker = startIngestionWorker({
    redisUrl: settings.redisUrl,
    memcore,
    sql,
    concurrency: 2,
  });
  logger.info({ redisUrl: settings.redisUrl }, "worker_started");

  const boundaryTimer = setInterval(() => {
    scanForBoundaries(sql, producer, {
      inactivityMinutes: settings.sessionInactivityMinutes,
      lengthThreshold: settings.sessionLengthThreshold,
    }).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err }, "boundary_scan_failed");
    });
  }, SCAN_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker_shutdown_start");
    clearInterval(boundaryTimer);
    await worker.close();
    await producer.close();
    await memcore.close();
    await sql.end({ timeout: 5 });
    logger.info("worker_shutdown_complete");
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "worker_startup_failed");
  process.exit(1);
});
