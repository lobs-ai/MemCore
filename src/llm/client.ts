/**
 * LLM client interface and tracked wrapper.
 *
 * The interface is intentionally bare — provide a concrete implementation
 * (e.g. an adapter around `@agentic/llm`) at startup. We ship no provider
 * SDKs; the contract is the type, not the import.
 */

import type { CostTracker } from "./cost-tracker.js";
import type { CreateMessageParams, LLMResponse } from "./types.js";

export interface LLMClient {
  createMessage(params: CreateMessageParams): Promise<LLMResponse>;
}

export class TrackedLLMClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    readonly tracker: CostTracker,
  ) {}

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    const response = await this.inner.createMessage(params);
    this.tracker.record(params.model, response.usage);
    return response;
  }
}
