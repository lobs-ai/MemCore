/**
 * Aggregate eval results into per-category accuracy / latency.
 *
 * Two scorers feed this aggregator: the cheap substring-match (`contains`)
 * and the LLM grader in `grader.ts`. The aggregation shape is the same for
 * both — only the per-case `passed` boolean differs.
 */

import type { Category, EvalResult } from "./types.js";

export interface CategoryReport {
  category: Category;
  total: number;
  passed: number;
  accuracy: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface Report {
  overall: { total: number; passed: number; accuracy: number };
  byCategory: CategoryReport[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function aggregate(results: EvalResult[]): Report {
  const byCategoryMap = new Map<Category, EvalResult[]>();
  for (const r of results) {
    const list = byCategoryMap.get(r.category) ?? [];
    list.push(r);
    byCategoryMap.set(r.category, list);
  }

  const byCategory: CategoryReport[] = [];
  for (const [category, list] of byCategoryMap) {
    const passed = list.filter((r) => r.passed).length;
    const latencies = list.map((r) => r.latencyMs);
    byCategory.push({
      category,
      total: list.length,
      passed,
      accuracy: list.length === 0 ? 0 : passed / list.length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    overall: {
      total: results.length,
      passed,
      accuracy: results.length === 0 ? 0 : passed / results.length,
    },
    byCategory,
  };
}
