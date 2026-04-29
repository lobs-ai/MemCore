import { describe, expect, it } from "vitest";
import { StubEmbedder } from "./stub-embedder.js";

describe("StubEmbedder", () => {
  it("emits vectors of the configured dimension", async () => {
    const emb = new StubEmbedder(64);
    const out = await emb.embed({ texts: ["hello", "world"] });
    expect(out.vectors).toHaveLength(2);
    for (const v of out.vectors) {
      expect(v).toHaveLength(64);
    }
  });

  it("L2-normalises each vector", async () => {
    const emb = new StubEmbedder(32);
    const out = await emb.embed({ texts: ["alpha"] });
    const v = out.vectors[0];
    if (!v) throw new Error("missing vector");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("is deterministic across calls and instances for the same text", async () => {
    const a = await new StubEmbedder(32).embed({ texts: ["repeat me"] });
    const b = await new StubEmbedder(32).embed({ texts: ["repeat me"] });
    expect(a.vectors[0]).toEqual(b.vectors[0]);
  });

  it("reports token usage roughly proportional to input word count", async () => {
    const emb = new StubEmbedder(8);
    const out = await emb.embed({ texts: ["one two three", "four"] });
    expect(out.usage.inputTokens).toBe(4);
    expect(out.usage.outputTokens).toBe(0);
  });

  it("rejects a non-positive dimension", () => {
    expect(() => new StubEmbedder(0)).toThrow();
    expect(() => new StubEmbedder(-1)).toThrow();
  });

  it("returns an empty vectors array when called with no texts", async () => {
    const out = await new StubEmbedder(8).embed({ texts: [] });
    expect(out.vectors).toEqual([]);
    expect(out.usage.inputTokens).toBe(0);
  });
});
