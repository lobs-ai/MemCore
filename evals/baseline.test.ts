import { describe, expect, it } from "vitest";
import { compareToBaseline, reportToBaseline } from "./baseline.js";
import type { Report } from "./metrics.js";

function makeReport(overall: number, byCategory: Record<string, number>): Report {
  const categories = Object.entries(byCategory).map(([category, accuracy]) => ({
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast across the Category union
    category: category as any,
    total: 10,
    passed: Math.round(accuracy * 10),
    accuracy,
    p50LatencyMs: 50,
    p95LatencyMs: 100,
  }));
  const total = categories.reduce((s, c) => s + c.total, 0);
  const passed = categories.reduce((s, c) => s + c.passed, 0);
  return {
    overall: { total, passed, accuracy: total === 0 ? 0 : passed / total },
    byCategory: categories,
  };
}

describe("reportToBaseline", () => {
  it("captures overall and per-category accuracy", () => {
    const report = makeReport(0.8, { single_session_recall: 0.9, abstain: 0.7 });
    const baseline = reportToBaseline(report, { grader: "llm" });
    expect(baseline.overall.accuracy).toBeCloseTo(0.8);
    expect(baseline.byCategory).toHaveLength(2);
    expect(baseline.capturedWith.grader).toBe("llm");
    expect(baseline.capturedAt).toMatch(/^\d{4}-/);
  });
});

describe("compareToBaseline", () => {
  it("passes when accuracy is unchanged", () => {
    const r = makeReport(0.8, { single_session_recall: 0.9, abstain: 0.7 });
    const b = reportToBaseline(r, { grader: "contains" });
    const result = compareToBaseline(b, r);
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("passes on small drops within tolerance", () => {
    const baseline = reportToBaseline(
      makeReport(0.8, { single_session_recall: 0.9, abstain: 0.7 }),
      { grader: "contains" },
    );
    const current = makeReport(0.78, { single_session_recall: 0.87, abstain: 0.69 });
    const result = compareToBaseline(baseline, current, 0.05);
    expect(result.ok).toBe(true);
  });

  it("passes on improvements", () => {
    const baseline = reportToBaseline(
      makeReport(0.8, { single_session_recall: 0.9, abstain: 0.7 }),
      { grader: "contains" },
    );
    const current = makeReport(0.95, { single_session_recall: 1.0, abstain: 0.9 });
    const result = compareToBaseline(baseline, current);
    expect(result.ok).toBe(true);
  });

  it("fails when a category drops beyond tolerance", () => {
    const baseline = reportToBaseline(
      makeReport(0.8, { single_session_recall: 0.9, abstain: 0.7 }),
      { grader: "contains" },
    );
    const current = makeReport(0.7, { single_session_recall: 0.6, abstain: 0.7 });
    const result = compareToBaseline(baseline, current, 0.05);
    expect(result.ok).toBe(false);
    const cats = result.failures.map((f) => f.category);
    expect(cats).toContain("single_session_recall");
  });

  it("fails when a previously-covered category is missing from the new report", () => {
    const baseline = reportToBaseline(
      makeReport(0.8, { single_session_recall: 0.9, abstain: 0.7 }),
      { grader: "contains" },
    );
    const current = makeReport(0.9, { single_session_recall: 0.9 });
    const result = compareToBaseline(baseline, current);
    expect(result.ok).toBe(false);
    const cats = result.failures.map((f) => f.category);
    expect(cats).toContain("abstain");
  });

  it("ignores new categories not present in the baseline", () => {
    const baseline = reportToBaseline(makeReport(0.8, { single_session_recall: 0.9 }), {
      grader: "contains",
    });
    const current = makeReport(0.85, { single_session_recall: 0.9, abstain: 0.8 });
    const result = compareToBaseline(baseline, current);
    expect(result.ok).toBe(true);
  });
});
