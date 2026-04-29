import { describe, expect, it } from "vitest";
import { chunkText } from "./chunker.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Hello, world.", { targetTokens: 100, minTokens: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ position: 0, content: "Hello, world." });
  });

  it("splits long text into overlapping chunks", () => {
    const text = "word ".repeat(600).trim();
    const chunks = chunkText(text, {
      targetTokens: 100,
      minTokens: 20,
      overlapTokens: 20,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(100);
    }
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
  });

  it("returns empty for empty input", () => {
    expect(chunkText("", { targetTokens: 100, minTokens: 50 })).toEqual([]);
    expect(chunkText("   \n  ", { targetTokens: 100, minTokens: 50 })).toEqual([]);
  });

  it("rejects overlap >= target", () => {
    expect(() =>
      chunkText("hello", { targetTokens: 10, minTokens: 5, overlapTokens: 10 }),
    ).toThrow();
  });
});
