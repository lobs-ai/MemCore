/**
 * Run the eval suite with MiniMax as the LLM (extraction, conflict,
 * contextualizer, temporal parser, profile generator, grader).
 *
 * MiniMax provides a chat-completions-only API at https://api.minimaxi.chat/v1
 * — no embeddings, no rerank. So this script:
 *   - Routes all LLM calls to MiniMax via LLM_BASE_URL.
 *   - Routes embeddings to a local OpenAI-compatible server (Ollama default).
 *   - Drops Cohere — passthrough reranker.
 *
 * Usage:
 *   MINIMAX_API_KEY=sk-... pnpm eval:minimax
 *   MINIMAX_API_KEY=sk-... pnpm eval:minimax --grader llm
 *   MINIMAX_API_KEY=sk-... pnpm eval:minimax --update-baseline
 *
 * Defaults:
 *   MINIMAX_BASE_URL          https://api.minimaxi.chat/v1
 *   MINIMAX_LLM_MODEL         MiniMax-M2.7
 *   LOCAL_EMBEDDING_BASE_URL  http://localhost:11434/v1   (Ollama)
 *   LOCAL_EMBEDDING_MODEL     nomic-embed-text
 *   MINIMAX_ABSTAIN_SIMILARITY_FLOOR  0.55                (calibrated for nomic)
 *
 * Override any of these via env to point embeddings at LMStudio, vLLM, OpenAI,
 * etc. The script never talks to MiniMax's embeddings endpoint — that's
 * intentional, MiniMax's embedder isn't part of this baseline.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const runnerPath = resolve(repoRoot, "evals", "runner.ts");

// The runner loads .env inside the subprocess via getSettings(), but we read
// MINIMAX_API_KEY here in the parent — so load .env up-front. Mirrors the
// minimal loader in src/config.ts.
function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(resolve(repoRoot, ".env"));

const e = process.env;
const apiKey = e.MINIMAX_API_KEY;
if (!apiKey) {
  console.error("✗ MINIMAX_API_KEY is not set. Drop the key in .env or export it before running.");
  process.exit(2);
}

const baseUrl = e.MINIMAX_BASE_URL ?? "https://api.minimaxi.chat/v1";
const llmModel = e.MINIMAX_LLM_MODEL ?? "MiniMax-M2.7";
const abstainFloor = e.MINIMAX_ABSTAIN_SIMILARITY_FLOOR ?? "0.55";
const embeddingBaseUrl = e.LOCAL_EMBEDDING_BASE_URL ?? "http://localhost:11434/v1";
const embeddingApiKey = e.LOCAL_EMBEDDING_API_KEY ?? "ollama";
const embeddingModel = e.LOCAL_EMBEDDING_MODEL ?? "nomic-embed-text";

const overlay: Record<string, string> = {
  // LLM → MiniMax. The OpenAILLMClient honours LLM_BASE_URL; the OPENAI_API_KEY
  // is a misnomer here (it's whatever bearer the OpenAI-compatible LLM client
  // uses) — we set it to the MiniMax key.
  OPENAI_API_KEY: apiKey,
  LLM_BASE_URL: baseUrl,
  EXTRACTION_MODEL: llmModel,
  CONFLICT_MODEL: llmModel,
  CONTEXTUALIZER_MODEL: llmModel,
  TEMPORAL_PARSER_MODEL: llmModel,
  PROFILE_GENERATOR_MODEL: llmModel,
  // Embeddings → local. MiniMax has no embeddings product in this baseline.
  EMBEDDING_API_KEY: embeddingApiKey,
  EMBEDDING_BASE_URL: embeddingBaseUrl,
  EMBEDDING_MODEL: embeddingModel,
  ABSTAIN_SIMILARITY_FLOOR: abstainFloor,
  // No Cohere — passthrough reranker.
  COHERE_API_KEY: "",
};

const args = process.argv.slice(2);

console.log("=== minimax-eval ===");
console.log(`  llm:        ${llmModel}  @ ${baseUrl}`);
console.log(`  embedding:  ${embeddingModel}  @ ${embeddingBaseUrl}`);
console.log(`  abstain:    floor=${abstainFloor}`);
console.log(`  forwarding: ${args.join(" ") || "(no flags)"}`);
console.log("");

const child = spawn("pnpm", ["exec", "tsx", runnerPath, ...args], {
  stdio: "inherit",
  cwd: repoRoot,
  env: { ...process.env, ...overlay },
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
