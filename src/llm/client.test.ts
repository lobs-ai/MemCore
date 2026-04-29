import { describe, expect, it, vi } from "vitest";
import { type LLMClient, TrackedLLMClient } from "./client.js";
import { CostTracker } from "./cost-tracker.js";
import type { LLMResponse } from "./types.js";

function fakeResponse(): LLMResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("TrackedLLMClient", () => {
  it("forwards createMessage to the inner client and records usage", async () => {
    const inner: LLMClient = { createMessage: vi.fn().mockResolvedValue(fakeResponse()) };
    const tracker = new CostTracker();
    const tracked = new TrackedLLMClient(inner, tracker);

    const response = await tracked.createMessage({
      model: "gpt-4o-mini",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });

    expect(response.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(inner.createMessage).toHaveBeenCalledTimes(1);
    const total = tracker.total();
    expect(total.calls).toBe(1);
    expect(total.tokens).toBe(15);
    expect(total.costUsd).toBeGreaterThan(0);
  });

  it("propagates errors from the inner client without recording usage", async () => {
    const inner: LLMClient = {
      createMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const tracker = new CostTracker();
    const tracked = new TrackedLLMClient(inner, tracker);

    await expect(
      tracked.createMessage({
        model: "gpt-4o-mini",
        system: "",
        messages: [],
        maxTokens: 10,
      }),
    ).rejects.toThrow("boom");
    expect(tracker.total().calls).toBe(0);
  });
});
