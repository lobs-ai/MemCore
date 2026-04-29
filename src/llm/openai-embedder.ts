/**
 * Default `Embedder` implementation against any OpenAI-compatible
 * `/v1/embeddings` endpoint.
 *
 * Despite the name, this works for every provider that speaks the OpenAI
 * embeddings wire format: OpenAI itself, LMStudio, Ollama, vLLM, llama.cpp's
 * server, etc. Pass `baseUrl` to point at the local endpoint.
 *
 *   new OpenAIEmbedder({                          // OpenAI
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: "text-embedding-3-large",
 *   })
 *   new OpenAIEmbedder({                          // LMStudio
 *     apiKey: "lm-studio",                        //   any string is fine
 *     baseUrl: "http://localhost:1234/v1",
 *     model: "nomic-embed-text-v1.5",
 *   })
 *
 * Uses native `fetch` directly instead of the openai SDK — embeddings are a
 * one-endpoint feature and we don't need the SDK's streaming, retries, or
 * chat-completions surface area. Keeps the LLM module SDK-free. Providers
 * that don't speak the OpenAI shape implement `Embedder` directly.
 */

import { ProviderError, RateLimitError } from "../errors.js";
import type { Embedder } from "./embedder.js";
import type { EmbeddingResponse } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 30_000;

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbedder implements Embedder {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbedderOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed({ texts }: { texts: string[] }): Promise<EmbeddingResponse> {
    if (texts.length === 0) {
      return {
        vectors: [],
        model: this.model,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(`OpenAI embeddings request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new RateLimitError("OpenAI embeddings rate limit hit");
    }
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(`OpenAI embeddings returned ${response.status}: ${text}`);
    }

    const body = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
      usage?: { prompt_tokens?: number };
    };
    // API contract: `data` is ordered to match the input array. Trust that
    // rather than re-sorting by `index` — the docs guarantee it.
    const vectors = body.data.map((d) => d.embedding);
    return {
      vectors,
      model: this.model,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: 0,
      },
    };
  }
}

/**
 * Alias for callers who want the name to reflect the broader use case (any
 * OpenAI-compatible endpoint, not just OpenAI). Identical to `OpenAIEmbedder`.
 */
export const OpenAICompatibleEmbedder = OpenAIEmbedder;
export type OpenAICompatibleEmbedderOptions = OpenAIEmbedderOptions;
