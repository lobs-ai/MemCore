/**
 * Server entry point. `pnpm dev` (tsx) or `node dist/api/main.js`.
 *
 * Builds a `MemCore` instance from env, hands it to `buildServer`, listens.
 * Graceful shutdown closes the server first (drain in-flight requests), then
 * the SDK pool.
 */

import { getSettings } from "../config.js";
import { getLogger } from "../logging.js";
import { MemCore } from "../memcore.js";
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
    chunkMaxTokens: settings.chunkMaxTokens,
    chunkMinTokens: settings.chunkMinTokens,
  });

  const app = buildServer({ memcore });
  await app.listen({ port: settings.port, host: "0.0.0.0" });
  logger.info({ port: settings.port }, "api_listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "api_shutdown_start");
    await app.close();
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
