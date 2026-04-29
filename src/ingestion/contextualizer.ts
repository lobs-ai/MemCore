/**
 * Chunk contextualizer.
 *
 * For each chunk, produce a 1–2 sentence prefix that situates it inside the
 * full session: who is speaking, what topic, which earlier decision the chunk
 * builds on. The prefix is prepended to the chunk before embedding so vector
 * search can match queries that reference context the chunk itself doesn't
 * spell out — the standard "contextual retrieval" trick.
 *
 * Prompt shape is deliberate for caching: the system prompt holds the
 * instructions plus the full session as a stable prefix; only the chunk
 * varies per call. Providers that support prompt caching (Anthropic explicit,
 * OpenAI automatic prefix) reuse the prefix across every chunk in the same
 * session, which is the cost-control lever called out in SPEC § Cost controls.
 *
 * Skipped for very short chunks: < 50 tokens does not need disambiguation and
 * the LLM call dominates ingestion latency.
 */

import { encode } from "gpt-tokenizer";

import type { LLMClient } from "../llm/client.js";
import { responseText } from "../llm/types.js";
import { getLogger } from "../logging.js";
import { CONTEXTUALIZER_PROMPT_VERSION, format, loadPrompt } from "../prompts/loader.js";

const logger = getLogger("ingestion.contextualizer");

const INSTRUCTIONS = loadPrompt("contextualizer_v1");

const SYSTEM_TEMPLATE = `${INSTRUCTIONS}\n\n<session>\n{session}\n</session>`;

const SHORT_CHUNK_TOKEN_THRESHOLD = 50;

export interface ContextualizeArgs {
  /** The full session text. Kept identical across all chunks in a batch so caching works. */
  sessionText: string;
  /** Chunks to contextualize, in order. */
  chunks: { content: string; tokenCount: number }[];
}

export interface ContextualizeDeps {
  llm: LLMClient;
  model: string;
  maxTokens?: number;
  /** Override the short-chunk skip threshold; mostly for tests. */
  shortChunkThreshold?: number;
}

export async function contextualizeChunks(
  deps: ContextualizeDeps,
  args: ContextualizeArgs,
): Promise<(string | null)[]> {
  const threshold = deps.shortChunkThreshold ?? SHORT_CHUNK_TOKEN_THRESHOLD;
  const system = format(SYSTEM_TEMPLATE, { session: args.sessionText });

  const out: (string | null)[] = new Array(args.chunks.length).fill(null);
  for (let i = 0; i < args.chunks.length; i += 1) {
    const chunk = args.chunks[i];
    if (!chunk) continue;
    if (chunk.tokenCount < threshold) {
      out[i] = null;
      continue;
    }
    try {
      out[i] = await contextualizeOne(deps, system, chunk.content);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, chunkIndex: i },
        "contextualizer_failed_skipping_chunk",
      );
      out[i] = null;
    }
  }
  return out;
}

async function contextualizeOne(
  deps: ContextualizeDeps,
  system: string,
  chunkContent: string,
): Promise<string | null> {
  const response = await deps.llm.createMessage({
    model: deps.model,
    system,
    messages: [{ role: "user", content: `<chunk>\n${chunkContent}\n</chunk>` }],
    maxTokens: deps.maxTokens ?? 128,
    temperature: 0,
  });

  const text = responseText(response).trim();
  if (!text) return null;
  // Models occasionally wrap output in quotes or fences despite instructions.
  return cleanPrefix(text);
}

function cleanPrefix(text: string): string {
  let t = text.trim();
  // Strip ```fenced``` wrappers.
  const fence = t.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  // Strip leading/trailing surrounding quotes if symmetric.
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (first && last && first === last && (first === '"' || first === "'")) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

/**
 * Helper for callers who want to pre-check whether contextualization will
 * actually run (to avoid loading the LLM client when no chunk qualifies).
 */
export function shouldContextualize(tokenCount: number): boolean {
  return tokenCount >= SHORT_CHUNK_TOKEN_THRESHOLD;
}

export function tokenCount(text: string): number {
  return encode(text).length;
}

export { CONTEXTUALIZER_PROMPT_VERSION };
