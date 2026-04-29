import { describe, expect, it } from "vitest";
import { CostTracker } from "./cost-tracker.js";

describe("CostTracker", () => {
  it("aggregates known-model usage into a non-zero cost", () => {
    const tracker = new CostTracker();
    tracker.record("claude-haiku-4-5", { inputTokens: 1_000_000, outputTokens: 500_000 });
    const total = tracker.total();
    expect(total.calls).toBe(1);
    expect(total.costUsd).toBeCloseTo(1.0 + 2.5, 5);
    expect(total.tokens).toBe(1_500_000);
  });

  it("records unknown models with zero cost but non-zero token count", () => {
    const tracker = new CostTracker();
    tracker.record("totally-made-up", { inputTokens: 100, outputTokens: 50 });
    const total = tracker.total();
    expect(total.costUsd).toBe(0);
    expect(total.tokens).toBe(150);
    expect(total.calls).toBe(1);
  });
});
