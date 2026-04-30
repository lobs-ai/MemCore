/**
 * Run the eval suite against a local OpenAI-compatible LLM + embedder.
 *
 * Wraps `pnpm eval` by re-pointing the OPENAI_* / EMBEDDING_* env vars at the
 * `LOCAL_*` ones the test client already understands. Use this to get the
 * eval numbers on a developer laptop without paying for OpenAI/Cohere — the
 * grader and reranker fall back to local-stack-friendly defaults.
 *
 * Usage:
 *   pnpm eval:local
 *   pnpm eval:local --grader llm
 *   pnpm eval:local --baseline               # compare against evals/baseline.json
 *   pnpm eval:local --update-baseline        # write evals/baseline.json
 *
 * All flags after `pnpm eval:local` pass through to the eval runner.
 *
 * Note: the local stack means no Cohere reranker — the runner falls back to
 * the passthrough reranker (RRF order). Numbers won't match a Cohere run.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");
const runnerPath = resolve(repoRoot, "evals", "runner.ts");

const e = process.env;
const llmBaseUrl = e.LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1";
const llmApiKey = e.LOCAL_LLM_API_KEY ?? "ollama";
const llmModel = e.LOCAL_LLM_MODEL ?? "qwen2.5:7b";
const embeddingBaseUrl = e.LOCAL_EMBEDDING_BASE_URL ?? "http://localhost:11434/v1";
const embeddingApiKey = e.LOCAL_EMBEDDING_API_KEY ?? "ollama";
const embeddingModel = e.LOCAL_EMBEDDING_MODEL ?? "nomic-embed-text";

// The eval runner reads these vars via getSettings() and honors
// LLM_BASE_URL + EMBEDDING_BASE_URL when building its OpenAI-compatible
// clients, so re-pointing them at a local server is enough.
const overlay: Record<string, string> = {
  OPENAI_API_KEY: llmApiKey,
  LLM_BASE_URL: llmBaseUrl,
  EMBEDDING_API_KEY: embeddingApiKey,
  EMBEDDING_BASE_URL: embeddingBaseUrl,
  EMBEDDING_MODEL: embeddingModel,
  EXTRACTION_MODEL: llmModel,
  CONFLICT_MODEL: llmModel,
  CONTEXTUALIZER_MODEL: llmModel,
  // Cohere reranker is paid and rarely available locally — drop the key so
  // the runner falls back to the passthrough reranker.
  COHERE_API_KEY: "",
};

const args = process.argv.slice(2);

console.log("=== local-eval ===");
console.log(`  llm:        ${llmBaseUrl}  (${llmModel})`);
console.log(`  embedding:  ${embeddingBaseUrl}  (${embeddingModel})`);
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
