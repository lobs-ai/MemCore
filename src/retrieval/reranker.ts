/**
 * Cross-encoder reranker.
 *
 * Two implementations:
 *
 *   - `CohereReranker`  — calls Cohere `/v2/rerank` over fetch (no SDK).
 *   - `PassthroughReranker` — returns inputs in their original order. Used
 *                              when no `COHERE_API_KEY` is configured so the
 *                              search path still works without an external
 *                              dependency.
 *
 * Anything else (BGE local, Voyage rerank, Jina, etc.) implements `Reranker`
 * and gets injected through `MemCore({ reranker })`. We ship no SDKs.
 *
 * The reranker dominates retrieval latency (~120ms in SPEC's budget). It runs
 * over the top 30 fused candidates and returns the top `limit` (default 10).
 */

import { ProviderError, RateLimitError } from "../errors.js";

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankedHit {
  id: string;
  score: number;
}

export interface RerankArgs {
  query: string;
  documents: RerankDocument[];
  topN: number;
}

export interface Reranker {
  rerank(args: RerankArgs): Promise<RerankedHit[]>;
}

const COHERE_DEFAULT_BASE_URL = "https://api.cohere.com";
const TIMEOUT_MS = 30_000;

export interface CohereRerankerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface CohereRerankResponse {
  results: { index: number; relevance_score: number }[];
}

export class CohereReranker implements Reranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CohereRerankerOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "rerank-v3.5";
    this.baseUrl = (opts.baseUrl ?? COHERE_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async rerank(args: RerankArgs): Promise<RerankedHit[]> {
    if (args.documents.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v2/rerank`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          query: args.query,
          documents: args.documents.map((d) => d.text),
          top_n: Math.min(args.topN, args.documents.length),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(`Cohere rerank request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new RateLimitError("Cohere rerank rate limit hit");
    }
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(`Cohere rerank returned ${response.status}: ${text}`);
    }

    const json = (await response.json()) as CohereRerankResponse;
    return json.results.map((r) => {
      const doc = args.documents[r.index];
      if (!doc) {
        throw new ProviderError(`Cohere rerank returned out-of-range index ${r.index}`);
      }
      return { id: doc.id, score: r.relevance_score };
    });
  }
}

/**
 * No-op reranker. Preserves input order and trims to topN. Used when no
 * Cohere key is configured so the retrieval pipeline still completes.
 */
export class PassthroughReranker implements Reranker {
  async rerank(args: RerankArgs): Promise<RerankedHit[]> {
    return args.documents.slice(0, args.topN).map((d, i) => ({
      id: d.id,
      // Score is a synthetic descending series so callers ordering by score
      // get the same order as the input.
      score: 1 - i / Math.max(1, args.documents.length),
    }));
  }
}
