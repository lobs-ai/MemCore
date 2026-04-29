import { describe, expect, it } from "vitest";

import { isProfileRelevant } from "./relevance.js";

describe("isProfileRelevant", () => {
  it("flags a direct profile request", () => {
    const out = isProfileRelevant("what do you know about me?");
    expect(out.isRelevant).toBe(true);
    expect(out.confidence).toBeGreaterThan(0.9);
  });

  it("flags 'tell me about myself'", () => {
    expect(isProfileRelevant("tell me about myself").isRelevant).toBe(true);
  });

  it("flags 'summarize the user'", () => {
    expect(isProfileRelevant("Can you summarize the user for me?").isRelevant).toBe(true);
  });

  it("flags 'who am I'", () => {
    expect(isProfileRelevant("who am i again?").isRelevant).toBe(true);
  });

  it("flags 'describe the user'", () => {
    expect(isProfileRelevant("describe the user in three sentences").isRelevant).toBe(true);
  });

  it("flags 'my profile'", () => {
    expect(isProfileRelevant("show me my profile").isRelevant).toBe(true);
  });

  it("flags 'everything you know about me'", () => {
    expect(isProfileRelevant("tell me everything you know about me").isRelevant).toBe(true);
  });

  it("does NOT flag a single-fact query that contains 'me'", () => {
    expect(isProfileRelevant("when did Maya finish her fellowship for me?").isRelevant).toBe(false);
  });

  it("does NOT flag a preference query", () => {
    expect(isProfileRelevant("what does the user prefer for breakfast?").isRelevant).toBe(false);
  });

  it("does NOT flag a temporal query", () => {
    expect(isProfileRelevant("what did I work on last summer?").isRelevant).toBe(false);
  });

  it("returns no match for an empty query", () => {
    const out = isProfileRelevant("");
    expect(out.isRelevant).toBe(false);
    expect(out.confidence).toBe(0);
    expect(out.matched).toEqual([]);
  });

  it("respects a higher threshold", () => {
    const out = isProfileRelevant("describe the user", 0.95);
    // 'describe the user' has weight 0.9 — at threshold 0.95 it should not pass.
    expect(out.confidence).toBeCloseTo(0.9);
    expect(out.isRelevant).toBe(false);
  });
});
