import { describe, expect, it } from "vitest";

import type { LLMClient } from "../llm/client.js";
import type { CreateMessageParams, LLMResponse } from "../llm/types.js";
import { extractMemories } from "./extractor.js";

function llmReturning(text: string): LLMClient {
  return {
    async createMessage(_params: CreateMessageParams): Promise<LLMResponse> {
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

describe("extractMemories", () => {
  it("parses a clean JSON array", async () => {
    const llm = llmReturning(
      JSON.stringify([
        { content: "User has a dog named Biscuit", category: "fact", confidence: 0.95 },
      ]),
    );
    const out = await extractMemories(
      { llm, model: "test" },
      { chunkContent: "I have a dog named Biscuit." },
    );
    expect(out).toEqual([
      { content: "User has a dog named Biscuit", category: "fact", confidence: 0.95 },
    ]);
  });

  it("returns [] on an empty array response", async () => {
    const llm = llmReturning("[]");
    const out = await extractMemories({ llm, model: "test" }, { chunkContent: "Hello there." });
    expect(out).toEqual([]);
  });

  it("strips ```json fences before parsing", async () => {
    const llm = llmReturning(
      '```json\n[{"content":"User likes oatmeal","category":"preference","confidence":0.9}]\n```',
    );
    const out = await extractMemories({ llm, model: "test" }, { chunkContent: "I like oatmeal." });
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe("preference");
  });

  it("throws on invalid category", async () => {
    const llm = llmReturning(
      JSON.stringify([{ content: "x", category: "totally-made-up", confidence: 0.5 }]),
    );
    await expect(extractMemories({ llm, model: "test" }, { chunkContent: "x" })).rejects.toThrow();
  });

  it("throws when no JSON array is present", async () => {
    const llm = llmReturning("I cannot help with that.");
    await expect(extractMemories({ llm, model: "test" }, { chunkContent: "x" })).rejects.toThrow();
  });
});
