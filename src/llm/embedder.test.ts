import { describe, expect, it, vi } from "vitest";
import { CostTracker } from "./cost-tracker.js";
import { type Embedder, TrackedEmbedder } from "./embedder.js";

function makeInner(model = "text-embedding-3-large"): Embedder {
  return {
    embed: vi.fn().mockResolvedValue({
      vectors: [[0.1, 0.2]],
      model,
      usage: { inputTokens: 7, outputTokens: 0 },
    }),
  };
}

describe("TrackedEmbedder", () => {
  it("forwards embed to the inner embedder and records usage", async () => {
    const inner = makeInner();
    const tracker = new CostTracker();
    const tracked = new TrackedEmbedder(inner, tracker);
    const out = await tracked.embed({ texts: ["hello"] });
    expect(out.vectors).toEqual([[0.1, 0.2]]);
    expect(inner.embed).toHaveBeenCalledWith({ texts: ["hello"] });
    expect(tracker.total().calls).toBe(1);
    expect(tracker.total().tokens).toBe(7);
  });

  it("uses the model returned by the inner response for cost lookup", async () => {
    const inner = makeInner("text-embedding-3-small");
    const tracker = new CostTracker();
    const tracked = new TrackedEmbedder(inner, tracker);
    await tracked.embed({ texts: ["a", "b"] });
    const records = tracker.history();
    expect(records[0]?.model).toBe("text-embedding-3-small");
  });
});
