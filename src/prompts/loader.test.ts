import { describe, expect, it } from "vitest";
import {
  CONFLICT_DETECTOR_PROMPT_VERSION,
  CONTEXTUALIZER_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  PROFILE_GENERATOR_PROMPT_VERSION,
  TEMPORAL_PARSER_PROMPT_VERSION,
  format,
  loadPrompt,
} from "./loader.js";

describe("prompts/loader", () => {
  it("loads a prompt file from disk", () => {
    const text = loadPrompt("extraction_v2");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("{document_date}");
  });

  it("returns the same string instance on a second call (cached)", () => {
    const a = loadPrompt("extraction_v2");
    const b = loadPrompt("extraction_v2");
    expect(a).toBe(b);
  });

  it("throws when the prompt file is missing", () => {
    expect(() => loadPrompt("does_not_exist_v9")).toThrow();
  });

  it("substitutes {var} tokens", () => {
    const out = format("hello {name}, today is {date}", {
      name: "Maya",
      date: "2026-04-29",
    });
    expect(out).toBe("hello Maya, today is 2026-04-29");
  });

  it("throws when a referenced variable is missing", () => {
    expect(() => format("hi {who}", {})).toThrow(/missing prompt variable: who/);
  });

  it("leaves single braces alone if they don't match the {word} pattern", () => {
    expect(format("a { b } c {name}", { name: "x" })).toBe("a { b } c x");
  });

  it("exposes versioned constants", () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe("v3");
    expect(CONTEXTUALIZER_PROMPT_VERSION).toBe("v1");
    expect(CONFLICT_DETECTOR_PROMPT_VERSION).toBe("v1");
    expect(TEMPORAL_PARSER_PROMPT_VERSION).toBe("v1");
    expect(PROFILE_GENERATOR_PROMPT_VERSION).toBe("v1");
  });
});
