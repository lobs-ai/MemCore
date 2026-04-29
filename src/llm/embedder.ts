/**
 * Embedder interface and tracked wrapper.
 *
 * Separate from `LLMClient` because chat and embedding APIs have different
 * shapes and are usually backed by different services. Like `LLMClient`,
 * this is injectable — wire a concrete implementation at startup.
 */

import type { CostTracker } from "./cost-tracker.js";
import type { EmbeddingResponse } from "./types.js";

export interface Embedder {
  embed(input: { texts: string[] }): Promise<EmbeddingResponse>;
}

export class TrackedEmbedder implements Embedder {
  constructor(
    readonly inner: Embedder,
    readonly tracker: CostTracker,
  ) {}

  async embed(input: { texts: string[] }): Promise<EmbeddingResponse> {
    const response = await this.inner.embed(input);
    this.tracker.record(response.model, response.usage);
    return response;
  }
}
