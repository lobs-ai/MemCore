/**
 * Application configuration loaded from the environment.
 *
 * All knobs the system exposes live here. New env vars are documented in
 * SPEC.md § Configuration first, then mirrored in this file and `.env.example`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const SettingsSchema = z.object({
  // Storage
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),

  // Server
  port: z.coerce.number().int().positive().default(8000),

  // LLM providers (at least one of anthropic/openai is needed in practice).
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  cohereApiKey: z.string().optional(),

  // Embedding endpoint. Any OpenAI-compatible /v1/embeddings server works
  // (LMStudio, Ollama, vLLM, OpenAI itself). Falls back to OPENAI_API_KEY +
  // the public OpenAI base URL when these are unset.
  embeddingBaseUrl: z.string().optional(),
  embeddingApiKey: z.string().optional(),

  // LLM endpoint. Same shape as the embedding overrides above — set this to
  // run extraction / conflict / grader against a local OpenAI-compatible
  // server (Ollama on :11434, LMStudio on :1234, vLLM, etc.). Defaults to
  // the public OpenAI base URL.
  llmBaseUrl: z.string().optional(),

  // Models
  embeddingModel: z.string().default("text-embedding-3-large"),
  embeddingDim: z.coerce.number().int().positive().default(3072),
  extractionModel: z.string().default("claude-haiku-4-5"),
  conflictModel: z.string().default("claude-sonnet-4-6"),
  contextualizerModel: z.string().default("claude-haiku-4-5"),
  temporalParserModel: z.string().default("claude-haiku-4-5"),
  profileGeneratorModel: z.string().default("claude-haiku-4-5"),
  rerankerProvider: z.enum(["cohere", "local"]).default("cohere"),

  // Retrieval gates
  // Cosine floor below which `search()` returns shouldAbstain. Calibrated to
  // text-embedding-3-large (0.3); raise to ~0.55 for nomic-embed-text.
  abstainSimilarityFloor: z.coerce.number().default(0.3),

  // Ingestion
  sessionInactivityMinutes: z.coerce.number().int().positive().default(30),
  sessionLengthThreshold: z.coerce.number().int().positive().default(20),
  chunkMinTokens: z.coerce.number().int().positive().default(100),
  chunkMaxTokens: z.coerce.number().int().positive().default(800),
  chunkTopicShiftThreshold: z.coerce.number().default(0.35),

  // Retrieval
  rrfK: z.coerce.number().int().positive().default(60),

  // Logging
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Dev
  environment: z.enum(["development", "test", "production"]).default("development"),
  apiKeyDev: z.string().default("dev-key"),
});

export type Settings = z.infer<typeof SettingsSchema>;

let cached: Settings | null = null;

export function loadEnvFile(path = ".env"): void {
  // Minimal .env loader. We don't pull in dotenv just to read 12 keys —
  // the format we care about is `KEY=value`, ignoring blanks and comments.
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function getSettings(): Settings {
  if (cached) return cached;
  loadEnvFile();
  const e = process.env;
  const parsed = SettingsSchema.parse({
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    port: e.PORT,
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: e.OPENAI_API_KEY || undefined,
    cohereApiKey: e.COHERE_API_KEY || undefined,
    embeddingBaseUrl: e.EMBEDDING_BASE_URL || undefined,
    embeddingApiKey: e.EMBEDDING_API_KEY || undefined,
    llmBaseUrl: e.LLM_BASE_URL || undefined,
    embeddingModel: e.EMBEDDING_MODEL,
    embeddingDim: e.EMBEDDING_DIM,
    extractionModel: e.EXTRACTION_MODEL,
    conflictModel: e.CONFLICT_MODEL,
    contextualizerModel: e.CONTEXTUALIZER_MODEL,
    temporalParserModel: e.TEMPORAL_PARSER_MODEL,
    profileGeneratorModel: e.PROFILE_GENERATOR_MODEL,
    rerankerProvider: e.RERANKER_PROVIDER,
    abstainSimilarityFloor: e.ABSTAIN_SIMILARITY_FLOOR,
    sessionInactivityMinutes: e.SESSION_INACTIVITY_MINUTES,
    sessionLengthThreshold: e.SESSION_LENGTH_THRESHOLD,
    chunkMinTokens: e.CHUNK_MIN_TOKENS,
    chunkMaxTokens: e.CHUNK_MAX_TOKENS,
    chunkTopicShiftThreshold: e.CHUNK_TOPIC_SHIFT_THRESHOLD,
    rrfK: e.RRF_K,
    logLevel: e.LOG_LEVEL?.toLowerCase(),
    environment: e.ENVIRONMENT,
    apiKeyDev: e.API_KEY_DEV,
  });
  cached = parsed;
  return parsed;
}

export function resetSettingsForTest(): void {
  cached = null;
}
