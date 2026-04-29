import { describe, expect, it } from "vitest";

import type { LLMClient } from "../llm/client.js";
import type { CreateMessageParams, LLMResponse } from "../llm/types.js";
import { type ProfileMemoryRow, renderMemories } from "./generator.js";

class StubLLMClient implements LLMClient {
  public readonly calls: CreateMessageParams[] = [];
  constructor(private readonly text: string) {}
  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    this.calls.push(params);
    return {
      content: [{ type: "text", text: this.text }],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }
}

const sampleMemories: ProfileMemoryRow[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    content: "User lives in Brooklyn",
    category: "fact",
    status: "active",
    confidence: 0.95,
    eventDate: null,
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    content: "User is allergic to peanuts",
    category: "constraint",
    status: "active",
    confidence: 0.9,
    eventDate: null,
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    content: "User flew to Tokyo on 2026-05-29",
    category: "event",
    status: "active",
    confidence: 0.85,
    eventDate: new Date("2026-05-29T00:00:00Z"),
  },
];

describe("renderMemories", () => {
  it("includes one memory per line in pipe-delimited format", () => {
    const text = renderMemories(sampleMemories);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("fact");
    expect(lines[0]).toContain("User lives in Brooklyn");
    expect(lines[0]).toContain("0.95");
    expect(lines[0]).toContain("null");
  });

  it("emits ISO day for memories with an event_date", () => {
    const text = renderMemories(sampleMemories);
    expect(text).toContain("2026-05-29");
  });

  it("returns empty string for empty input", () => {
    expect(renderMemories([])).toBe("");
  });
});

describe("StubLLMClient (sanity check)", () => {
  it("captures the prompt and returns the canned text", async () => {
    const llm = new StubLLMClient("**Identity**\n- The user lives in Brooklyn.");
    const out = await llm.createMessage({
      model: "test",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(out.content[0]).toEqual({ type: "text", text: expect.stringContaining("Brooklyn") });
    expect(llm.calls).toHaveLength(1);
  });
});
