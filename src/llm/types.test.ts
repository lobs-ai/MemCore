import { describe, expect, it } from "vitest";
import { type LLMResponse, responseText } from "./types.js";

function r(...content: LLMResponse["content"]): LLMResponse {
  return {
    content,
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("responseText", () => {
  it("concatenates text blocks in order", () => {
    expect(responseText(r({ type: "text", text: "hello " }, { type: "text", text: "world" }))).toBe(
      "hello world",
    );
  });

  it("ignores tool_use blocks", () => {
    expect(
      responseText(
        r(
          { type: "text", text: "answer: " },
          { type: "tool_use", id: "1", name: "calc", input: { x: 1 } },
          { type: "text", text: "42" },
        ),
      ),
    ).toBe("answer: 42");
  });

  it("returns an empty string when the response has no text blocks", () => {
    expect(responseText(r({ type: "tool_use", id: "1", name: "t", input: {} }))).toBe("");
  });

  it("returns an empty string when content is empty", () => {
    expect(responseText(r())).toBe("");
  });
});
