import { describe, expect, it } from "vitest";

import type { LLMClient } from "../llm/client.js";
import type { CreateMessageParams, LLMResponse } from "../llm/types.js";
import {
  type ExistingMemory,
  type SimilarMemoryFinder,
  decisionToRelationship,
  detectConflicts,
} from "./conflict-detector.js";

interface RecordedCall {
  system: string;
  user: string;
}

function recordingLLM(replies: string[]): { llm: LLMClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const llm: LLMClient = {
    async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
      calls.push({ system: params.system, user: params.messages[0]?.content ?? "" });
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

function finder(per: ExistingMemory[][]): SimilarMemoryFinder {
  let i = 0;
  return async () => per[i++] ?? [];
}

const M1 = "11111111-1111-1111-1111-111111111111";
const M2 = "22222222-2222-2222-2222-222222222222";

describe("detectConflicts", () => {
  it("returns `new` without an LLM call when no candidate clears the threshold", async () => {
    const { llm, calls } = recordingLLM([]);
    const out = await detectConflicts(
      {
        llm,
        model: "test",
        findSimilar: finder([
          [{ id: M1, content: "old", category: "fact", documentDate: null, similarity: 0.4 }],
        ]),
        similarityThreshold: 0.75,
      },
      {
        containerId: "c1",
        candidates: [{ index: 0, content: "new fact", category: "fact", vector: [0.1, 0.2] }],
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.decision).toBe("new");
    expect(out[0]?.targetId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("classifies a clear update with the existing memory id", async () => {
    const { llm, calls } = recordingLLM([
      JSON.stringify({
        decision: "update",
        target_id: M1,
        confidence: 0.9,
        reason: "user moved",
      }),
    ]);
    const out = await detectConflicts(
      {
        llm,
        model: "test",
        findSimilar: finder([
          [
            {
              id: M1,
              content: "User lives in Boston",
              category: "fact",
              documentDate: null,
              similarity: 0.92,
            },
          ],
        ]),
      },
      {
        containerId: "c1",
        candidates: [
          { index: 0, content: "User lives in Brooklyn", category: "fact", vector: [0.5] },
        ],
      },
    );
    expect(out[0]?.decision).toBe("update");
    expect(out[0]?.targetId).toBe(M1);
    expect(calls[0]?.user).toContain("User lives in Brooklyn");
    expect(calls[0]?.user).toContain(M1);
  });

  it("falls back to `new` if the LLM returns a target_id not in the existing list", async () => {
    const { llm } = recordingLLM([
      JSON.stringify({
        decision: "update",
        target_id: M2,
        confidence: 0.9,
      }),
    ]);
    const out = await detectConflicts(
      {
        llm,
        model: "test",
        findSimilar: finder([
          [{ id: M1, content: "x", category: "fact", documentDate: null, similarity: 0.9 }],
        ]),
      },
      {
        containerId: "c1",
        candidates: [{ index: 0, content: "y", category: "fact", vector: [0.5] }],
      },
    );
    expect(out[0]?.decision).toBe("new");
    expect(out[0]?.targetId).toBeNull();
  });

  it("strips ```json fences in the response", async () => {
    const { llm } = recordingLLM([
      `\`\`\`json\n${JSON.stringify({
        decision: "duplicate",
        target_id: M1,
        confidence: 0.95,
      })}\n\`\`\``,
    ]);
    const out = await detectConflicts(
      {
        llm,
        model: "test",
        findSimilar: finder([
          [{ id: M1, content: "x", category: "fact", documentDate: null, similarity: 0.99 }],
        ]),
      },
      {
        containerId: "c1",
        candidates: [{ index: 0, content: "x", category: "fact", vector: [0.1] }],
      },
    );
    expect(out[0]?.decision).toBe("duplicate");
    expect(out[0]?.targetId).toBe(M1);
  });

  it("treats LLM failures as `new` so ingestion can proceed", async () => {
    const llm: LLMClient = {
      async createMessage(): Promise<LLMResponse> {
        throw new Error("boom");
      },
    };
    const out = await detectConflicts(
      {
        llm,
        model: "test",
        findSimilar: finder([
          [{ id: M1, content: "x", category: "fact", documentDate: null, similarity: 0.9 }],
        ]),
      },
      {
        containerId: "c1",
        candidates: [{ index: 0, content: "y", category: "fact", vector: [0.1] }],
      },
    );
    expect(out[0]?.decision).toBe("new");
  });
});

describe("decisionToRelationship", () => {
  it("maps writeable decisions to edge types", () => {
    expect(decisionToRelationship("update")).toBe("updates");
    expect(decisionToRelationship("extend")).toBe("extends");
    expect(decisionToRelationship("derive")).toBe("derives");
    expect(decisionToRelationship("contradicts")).toBe("contradicts");
  });

  it("returns null for `new` and `duplicate`", () => {
    expect(decisionToRelationship("new")).toBeNull();
    expect(decisionToRelationship("duplicate")).toBeNull();
  });
});
