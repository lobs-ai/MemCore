import { describe, expect, it } from "vitest";

import type { LLMClient } from "../llm/client.js";
import type { CreateMessageParams, LLMResponse } from "../llm/types.js";
import { contextualizeChunks } from "./contextualizer.js";

interface RecordedCall {
  system: string;
  user: string;
}

function recordingLLM(replies: string[]): { llm: LLMClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const llm: LLMClient = {
    async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
      const user = params.messages[0]?.content ?? "";
      calls.push({ system: params.system, user });
      const text = replies[i++] ?? "";
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return { llm, calls };
}

describe("contextualizeChunks", () => {
  it("skips chunks under the short-chunk threshold", async () => {
    const { llm, calls } = recordingLLM([]);
    const out = await contextualizeChunks(
      { llm, model: "test", shortChunkThreshold: 10 },
      {
        sessionText: "session",
        chunks: [{ content: "tiny", tokenCount: 5 }],
      },
    );
    expect(out).toEqual([null]);
    expect(calls).toHaveLength(0);
  });

  it("uses the same system prompt for every chunk in a session", async () => {
    const { llm, calls } = recordingLLM(["prefix one", "prefix two"]);
    await contextualizeChunks(
      { llm, model: "test", shortChunkThreshold: 0 },
      {
        sessionText: "shared session text",
        chunks: [
          { content: "chunk A", tokenCount: 100 },
          { content: "chunk B", tokenCount: 100 },
        ],
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.system).toBe(calls[1]?.system);
    expect(calls[0]?.system).toContain("shared session text");
    expect(calls[0]?.user).toContain("chunk A");
    expect(calls[1]?.user).toContain("chunk B");
  });

  it("strips fenced wrappers and surrounding quotes", async () => {
    const { llm } = recordingLLM(['```\n"A discussion about breakfast preferences."\n```']);
    const out = await contextualizeChunks(
      { llm, model: "test", shortChunkThreshold: 0 },
      { sessionText: "s", chunks: [{ content: "c", tokenCount: 100 }] },
    );
    expect(out[0]).toBe("A discussion about breakfast preferences.");
  });

  it("falls back to null when the LLM call throws", async () => {
    const llm: LLMClient = {
      async createMessage(): Promise<LLMResponse> {
        throw new Error("boom");
      },
    };
    const out = await contextualizeChunks(
      { llm, model: "test", shortChunkThreshold: 0 },
      { sessionText: "s", chunks: [{ content: "c", tokenCount: 100 }] },
    );
    expect(out).toEqual([null]);
  });
});
