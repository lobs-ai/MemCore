/**
 * Shared types for the LLM and embedding clients.
 *
 * The shape mirrors `@agentic/llm` so a thin adapter around that client
 * satisfies the `LLMClient` interface with no field renames.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CreateMessageParams {
  model: string;
  system: string;
  messages: LLMMessage[];
  maxTokens: number;
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
  thinkingContent?: string;
}

export interface EmbeddingResponse {
  vectors: number[][];
  model: string;
  usage: TokenUsage;
}

export function responseText(response: LLMResponse): string {
  return response.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
