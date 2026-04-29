/**
 * Server entry point. `pnpm dev` (tsx) or `node dist/api/main.js`.
 *
 * Builds a `MemCore` instance and an ingestion queue producer from env, hands
 * both to `buildServer`, listens. The actual ingestion happens in a separate
 * worker process (`pnpm worker`) — the API only enqueues. Graceful shutdown
 * drains in-flight HTTP requests, closes the queue, then the SDK pool.
 */

import { getSettings } from "../config.js";
import { getLogger } from "../logging.js";
import { MemCore } from "../memcore.js";
import { IngestionProducer } from "../queue/producer.js";
import { buildServer } from "./server.js";

const logger = getLogger("api.main");

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
    chunkMaxTokens: settings.chunkMaxTokens,
    chunkMinTokens: settings.chunkMinTokens,
  });

  const producer = new IngestionProducer({ redisUrl: settings.redisUrl });

  const app = buildServer({ memcore, producer });
  await app.listen({ port: settings.port, host: "0.0.0.0" });
  logger.info({ port: settings.port }, "api_listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "api_shutdown_start");
    await app.close();
    await producer.close();
    await memcore.close();
    logger.info("api_shutdown_complete");
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "api_startup_failed");
  process.exit(1);
});
