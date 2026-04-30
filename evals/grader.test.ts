import { describe, expect, it, vi } from "vitest";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMResponse } from "../src/llm/types.js";
import { LLMGrader, parseVerdict } from "./grader.js";
import type { EvalCase } from "./types.js";

function fakeResponse(text: string): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    case_id: "t1",
    category: "single_session_recall",
    question: "What city is the Eiffel Tower in?",
    expected_answer: "Paris",
    scoring: "contains",
    ...overrides,
  };
}

describe("parseVerdict", () => {
  it("parses a plain JSON object", () => {
    const v = parseVerdict('{"passed": true, "rationale": "answer present"}');
    expect(v.passed).toBe(true);
    expect(v.rationale).toBe("answer present");
  });

  it("parses JSON wrapped in a code fence", () => {
    const v = parseVerdict('```json\n{"passed": false, "rationale": "off topic"}\n```');
    expect(v.passed).toBe(false);
    expect(v.rationale).toBe("off topic");
  });

  it("treats non-JSON output as a fail with raw rationale", () => {
    const v = parseVerdict("Sure! The answer is yes.");
    expect(v.passed).toBe(false);
    expect(v.rationale).toContain("non-JSON");
  });

  it("treats malformed JSON as a fail", () => {
    // Has both braces but invalid contents — exercises the JSON.parse path.
    const v = parseVerdict('{"passed": true, "rationale": ]}');
    expect(v.passed).toBe(false);
    expect(v.rationale).toContain("parse failed");
  });

  it("treats truthy non-boolean passed as fail", () => {
    const v = parseVerdict('{"passed": "yes", "rationale": "hmm"}');
    expect(v.passed).toBe(false);
  });
});

describe("LLMGrader", () => {
  it("short-circuits abstain cases with zero results", async () => {
    const client: LLMClient = { createMessage: vi.fn() };
    const grader = new LLMGrader({ client, model: "test" });
    const verdict = await grader.grade({
      case: makeCase({ category: "abstain", scoring: "abstain" }),
      retrievedContents: [],
      shouldAbstain: true,
      resultsCount: 0,
    });
    expect(verdict.passed).toBe(true);
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it("calls the LLM for non-abstain cases and returns its verdict", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValue(fakeResponse('{"passed": true, "rationale": "Paris mentioned"}'));
    const grader = new LLMGrader({ client: { createMessage }, model: "test" });
    const verdict = await grader.grade({
      case: makeCase(),
      retrievedContents: ["The Eiffel Tower stands in Paris, France."],
      shouldAbstain: false,
      resultsCount: 1,
    });
    expect(verdict.passed).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(1);
    const args = (createMessage.mock.calls[0] ?? [])[0];
    expect(args.system).toContain("paraphrase");
    expect(args.messages[0].content).toContain("Paris");
  });

  it("uses the abstain system prompt when results exist on an abstain case", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValue(fakeResponse('{"passed": false, "rationale": "would mislead"}'));
    const grader = new LLMGrader({ client: { createMessage }, model: "test" });
    await grader.grade({
      case: makeCase({ category: "abstain", scoring: "abstain" }),
      retrievedContents: ["Some plausible-looking but wrong content."],
      shouldAbstain: false,
      resultsCount: 1,
    });
    const args = (createMessage.mock.calls[0] ?? [])[0];
    expect(args.system).toContain("abstain");
  });

  it("truncates long snippet lists", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValue(fakeResponse('{"passed": true, "rationale": "ok"}'));
    const grader = new LLMGrader({
      client: { createMessage },
      model: "test",
      maxSnippets: 2,
      maxSnippetChars: 10,
    });
    await grader.grade({
      case: makeCase(),
      retrievedContents: [
        "abcdefghijklmnop",
        "second snippet way too long",
        "third should be dropped",
      ],
      shouldAbstain: false,
      resultsCount: 3,
    });
    const args = (createMessage.mock.calls[0] ?? [])[0];
    const userMsg = args.messages[0].content as string;
    expect(userMsg).toContain("[1] abcdefghij…");
    expect(userMsg).toContain("[2] second sni…");
    expect(userMsg).not.toContain("third");
  });
});
