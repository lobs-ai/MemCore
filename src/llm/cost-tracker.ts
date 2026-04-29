/**
 * Aggregates token usage across LLM and embedding calls.
 *
 * Rates are coarse (USD per 1M tokens). Phase 1 uses this for observability
 * only; later phases gate ingestion on per-session cost ceilings.
 */

import type { TokenUsage } from "./types.js";

interface ModelRates {
  inputPer1M: number;
  outputPer1M: number;
}

// Approximate prices as of 2026-04. Cache reads/writes count as input tokens
// for the rough estimate — close enough for budget tracking.
const RATES: Record<string, ModelRates> = {
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-opus-4-7": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "text-embedding-3-large": { inputPer1M: 0.13, outputPer1M: 0 },
  "text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
};

export interface CostRecord {
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

export class CostTracker {
  private records: CostRecord[] = [];

  record(model: string, usage: TokenUsage): CostRecord {
    const rates = RATES[model];
    const inputTokens =
      usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const costUsd = rates
      ? (inputTokens / 1_000_000) * rates.inputPer1M +
        (usage.outputTokens / 1_000_000) * rates.outputPer1M
      : 0;
    const record: CostRecord = { model, usage, costUsd };
    this.records.push(record);
    return record;
  }

  total(): { tokens: number; costUsd: number; calls: number } {
    let tokens = 0;
    let costUsd = 0;
    for (const r of this.records) {
      tokens +=
        r.usage.inputTokens +
        r.usage.outputTokens +
        (r.usage.cacheReadTokens ?? 0) +
        (r.usage.cacheWriteTokens ?? 0);
      costUsd += r.costUsd;
    }
    return { tokens, costUsd, calls: this.records.length };
  }

  history(): readonly CostRecord[] {
    return this.records;
  }
}
