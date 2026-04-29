/**
 * Default `LLMClient` implementation against any OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 * Mirrors `OpenAIEmbedder`: the project ships no provider SDKs, only thin
 * fetch-based defaults so the boot path and eval harness work out of the box.
 * Anything that speaks the OpenAI chat-completions wire format works — OpenAI
 * itself, LMStudio, Ollama, vLLM, llama.cpp's server. Pass `baseUrl` to point
 * at a local endpoint.
 *
 * Anthropic users (or anyone outside the OpenAI shape) implement `LLMClient`
 * directly and pass it via the `llmClient` option on `MemCore`.
 */

import { ProviderError, RateLimitError } from "../errors.js";
import type { LLMClient } from "./client.js";
import type { ContentBlock, CreateMessageParams, LLMResponse, StopReason } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const TIMEOUT_MS = 60_000;

export interface OpenAILLMClientOptions {
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices: {
    message: { role: string; content: string | null };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAILLMClient implements LLMClient {
  private readonly apiKey: string;
  private readonly defaultModel: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAILLMClientOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    const messages: { role: string; content: string }[] = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    for (const m of params.messages) messages.push({ role: m.role, content: m.content });

    const body: Record<string, unknown> = {
      model: params.model || this.defaultModel,
      messages,
      max_tokens: params.maxTokens,
    };
    if (params.temperature != null) body.temperature = params.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(`OpenAI chat-completions request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new RateLimitError("OpenAI chat-completions rate limit hit");
    }
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(`OpenAI chat-completions returned ${response.status}: ${text}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const choice = json.choices[0];
    if (!choice) throw new ProviderError("OpenAI chat-completions returned no choices");

    const text = choice.message.content ?? "";
    const content: ContentBlock[] = [{ type: "text", text }];

    return {
      content,
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "stop";
  }
}

export const OpenAICompatibleLLMClient = OpenAILLMClient;
export type OpenAICompatibleLLMClientOptions = OpenAILLMClientOptions;
