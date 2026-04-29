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
        {
          content: "User has a dog named Biscuit",
          category: "fact",
          confidence: 0.95,
          event_date: null,
          event_date_precision: "unknown",
        },
      ]),
    );
    const out = await extractMemories(
      { llm, model: "test" },
      { chunkContent: "I have a dog named Biscuit." },
    );
    expect(out).toEqual([
      {
        content: "User has a dog named Biscuit",
        category: "fact",
        confidence: 0.95,
        eventDate: null,
        eventDatePrecision: "unknown",
      },
    ]);
  });

  it("parses event_date and resolves precision", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          content: "User had surgery on 2026-04-28",
          category: "event",
          confidence: 0.9,
          event_date: "2026-04-28",
          event_date_precision: "day",
        },
      ]),
    );
    const out = await extractMemories(
      { llm, model: "test" },
      {
        chunkContent: "Yesterday I had surgery.",
        documentDate: new Date("2026-04-29T12:00:00Z"),
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.eventDate?.toISOString()).toBe("2026-04-28T00:00:00.000Z");
    expect(out[0]?.eventDatePrecision).toBe("day");
  });

  it("forces precision to unknown when event_date is null", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          content: "User is vegetarian",
          category: "preference",
          confidence: 0.95,
          event_date: null,
          event_date_precision: "day",
        },
      ]),
    );
    const out = await extractMemories({ llm, model: "test" }, { chunkContent: "I'm vegetarian." });
    expect(out[0]?.eventDate).toBeNull();
    expect(out[0]?.eventDatePrecision).toBe("unknown");
  });

  it("defaults missing event_date fields to null/unknown", async () => {
    const llm = llmReturning(
      JSON.stringify([{ content: "User likes oatmeal", category: "preference", confidence: 0.9 }]),
    );
    const out = await extractMemories({ llm, model: "test" }, { chunkContent: "I like oatmeal." });
    expect(out[0]?.eventDate).toBeNull();
    expect(out[0]?.eventDatePrecision).toBe("unknown");
  });

  it("returns [] on an empty array response", async () => {
    const llm = llmReturning("[]");
    const out = await extractMemories({ llm, model: "test" }, { chunkContent: "Hello there." });
    expect(out).toEqual([]);
  });

  it("strips ```json fences before parsing", async () => {
    const llm = llmReturning(
      '```json\n[{"content":"User likes oatmeal","category":"preference","confidence":0.9,"event_date":null,"event_date_precision":"unknown"}]\n```',
    );
    const out = await extractMemories({ llm, model: "test" }, { chunkContent: "I like oatmeal." });
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe("preference");
  });

  it("throws on invalid category", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          content: "x",
          category: "totally-made-up",
          confidence: 0.5,
          event_date: null,
          event_date_precision: "unknown",
        },
      ]),
    );
    await expect(extractMemories({ llm, model: "test" }, { chunkContent: "x" })).rejects.toThrow();
  });

  it("throws when no JSON array is present", async () => {
    const llm = llmReturning("I cannot help with that.");
    await expect(extractMemories({ llm, model: "test" }, { chunkContent: "x" })).rejects.toThrow();
  });
});
