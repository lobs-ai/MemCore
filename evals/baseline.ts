/**
 * Baseline-comparison utilities for the eval runner.
 *
 * The baseline file is a checked-in JSON snapshot of accuracy per category.
 * The runner compares a fresh report against it and exits non-zero if any
 * category drops more than `tolerance` (default 0.05 = 5 percentage points).
 *
 * The baseline is intentionally accuracy-only — latency and cost drift are
 * informational and shouldn't fail CI. Running with stub embedders produces
 * meaningless numbers, so the file documents what mode it was captured in.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { Report } from "./metrics.js";
import type { Category } from "./types.js";

export interface BaselineEntry {
  category: Category;
  total: number;
  passed: number;
  accuracy: number;
}

export interface Baseline {
  /** Free-form note about how this baseline was captured (model, date, etc). */
  capturedAt: string;
  capturedWith: {
    grader: "contains" | "llm" | "both";
    embeddingModel?: string;
    extractionModel?: string;
  };
  overall: { total: number; passed: number; accuracy: number };
  byCategory: BaselineEntry[];
}

export interface RegressionResult {
  ok: boolean;
  failures: {
    category: Category | "overall";
    baseline: number;
    current: number;
    delta: number;
  }[];
}

export function reportToBaseline(report: Report, capturedWith: Baseline["capturedWith"]): Baseline {
  return {
    capturedAt: new Date().toISOString(),
    capturedWith,
    overall: report.overall,
    byCategory: report.byCategory.map((c) => ({
      category: c.category,
      total: c.total,
      passed: c.passed,
      accuracy: c.accuracy,
    })),
  };
}

export function loadBaseline(path: string): Baseline | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Baseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

/**
 * Compare current accuracy to the baseline. A category fails if its accuracy
 * dropped by more than `tolerance`. Categories that *gained* accuracy never
 * fail — improvements are good, even if surprising. Categories present in the
 * baseline but missing from the current report fail (someone removed coverage).
 * Categories present in the current run but missing from the baseline are
 * informational only — the baseline file just hasn't been updated yet.
 */
export function compareToBaseline(
  baseline: Baseline,
  report: Report,
  tolerance = 0.05,
): RegressionResult {
  const failures: RegressionResult["failures"] = [];
  // Float-point slack: 17/20 - 9/10 lands at -0.0500000000000000044 in IEEE,
  // which would fail a literal `< -0.05` comparison. The eval signal is never
  // that tight anyway.
  const epsilon = 1e-9;

  const overallDelta = report.overall.accuracy - baseline.overall.accuracy;
  if (overallDelta < -tolerance - epsilon) {
    failures.push({
      category: "overall",
      baseline: baseline.overall.accuracy,
      current: report.overall.accuracy,
      delta: overallDelta,
    });
  }

  const currentByCategory = new Map(report.byCategory.map((c) => [c.category, c]));
  for (const entry of baseline.byCategory) {
    const current = currentByCategory.get(entry.category);
    if (!current) {
      failures.push({
        category: entry.category,
        baseline: entry.accuracy,
        current: 0,
        delta: -entry.accuracy,
      });
      continue;
    }
    const delta = current.accuracy - entry.accuracy;
    if (delta < -tolerance - epsilon) {
      failures.push({
        category: entry.category,
        baseline: entry.accuracy,
        current: current.accuracy,
        delta,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}
