import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettings, resetSettingsForTest } from "./config.js";

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "COHERE_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EXTRACTION_MODEL",
  "CONFLICT_MODEL",
  "CONTEXTUALIZER_MODEL",
  "RERANKER_PROVIDER",
  "PORT",
  "SESSION_INACTIVITY_MINUTES",
  "SESSION_LENGTH_THRESHOLD",
  "CHUNK_MIN_TOKENS",
  "CHUNK_MAX_TOKENS",
  "CHUNK_TOPIC_SHIFT_THRESHOLD",
  "RRF_K",
  "LOG_LEVEL",
  "ENVIRONMENT",
  "API_KEY_DEV",
];

describe("config", () => {
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = {};
    for (const k of REQUIRED_KEYS) snapshot[k] = process.env[k];
    for (const k of REQUIRED_KEYS) delete process.env[k];
    resetSettingsForTest();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSettingsForTest();
  });

  it("parses minimal env with defaults", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h:5432/d";
    process.env.REDIS_URL = "redis://localhost:6379/0";
    const s = getSettings();
    expect(s.databaseUrl).toBe("postgresql://u:p@h:5432/d");
    expect(s.redisUrl).toBe("redis://localhost:6379/0");
    expect(s.port).toBe(8000);
    expect(s.embeddingModel).toBe("text-embedding-3-large");
    expect(s.embeddingDim).toBe(3072);
    expect(s.logLevel).toBe("info");
    expect(s.environment).toBe("development");
    expect(s.apiKeyDev).toBe("dev-key");
    expect(s.rrfK).toBe(60);
  });

  it("coerces numeric env vars and lowercases LOG_LEVEL", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h:5432/d";
    process.env.REDIS_URL = "redis://localhost:6379/0";
    process.env.PORT = "9000";
    process.env.RRF_K = "120";
    process.env.LOG_LEVEL = "DEBUG";
    const s = getSettings();
    expect(s.port).toBe(9000);
    expect(s.rrfK).toBe(120);
    expect(s.logLevel).toBe("debug");
  });

  it("treats empty API keys as undefined", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h:5432/d";
    process.env.REDIS_URL = "redis://localhost:6379/0";
    process.env.OPENAI_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    const s = getSettings();
    expect(s.openaiApiKey).toBeUndefined();
    expect(s.anthropicApiKey).toBeUndefined();
  });

  it("caches the parsed settings until reset", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h:5432/d";
    process.env.REDIS_URL = "redis://localhost:6379/0";
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b);
    resetSettingsForTest();
    const c = getSettings();
    expect(c).not.toBe(a);
  });

  it("rejects an invalid DATABASE_URL", () => {
    process.env.DATABASE_URL = "not a url";
    process.env.REDIS_URL = "redis://localhost:6379/0";
    expect(() => getSettings()).toThrow();
  });

  it("rejects an invalid log level", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h:5432/d";
    process.env.REDIS_URL = "redis://localhost:6379/0";
    process.env.LOG_LEVEL = "loud";
    expect(() => getSettings()).toThrow();
  });
});
