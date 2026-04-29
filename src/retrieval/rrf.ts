/**
 * Reciprocal Rank Fusion.
 *
 *   score(d) = Σ_S 1 / (k + rank_S(d))
 *
 * Where each S is a ranked list of document ids and `rank_S(d)` is 1-based.
 * Documents missing from a list contribute 0 from that list. RRF cares only
 * about ranks, not raw scores — that's the whole reason it works across leg-
 * incommensurable signals (cosine vs ts_rank_cd vs whatever).
 *
 * This module is a pure function. Callers pass arrays of ids in rank order
 * (no objects, no scores) and get back a fused id list with summed RRF scores.
 *
 * `k` defaults to 60 per the original Cormack/Clarke/Buettcher paper — that
 * value's a defensible knob and not worth tuning before we have eval signal.
 */

export interface RrfHit {
  id: string;
  score: number;
  /** Per-list contributions. Useful when debugging why something ranked where it did. */
  contributions: { listIndex: number; rank: number; partial: number }[];
}

export interface FuseOptions {
  k?: number;
  /** Hard cap on output size after fusion. Defaults to no cap. */
  limit?: number;
}

const DEFAULT_K = 60;

export function fuseRanks(rankedLists: string[][], opts: FuseOptions = {}): RrfHit[] {
  const k = opts.k ?? DEFAULT_K;
  const accum = new Map<string, RrfHit>();

  for (let listIndex = 0; listIndex < rankedLists.length; listIndex += 1) {
    const list = rankedLists[listIndex];
    if (!list) continue;
    for (let i = 0; i < list.length; i += 1) {
      const id = list[i];
      if (!id) continue;
      const rank = i + 1;
      const partial = 1 / (k + rank);
      const existing = accum.get(id);
      if (existing) {
        existing.score += partial;
        existing.contributions.push({ listIndex, rank, partial });
      } else {
        accum.set(id, {
          id,
          score: partial,
          contributions: [{ listIndex, rank, partial }],
        });
      }
    }
  }

  const fused = [...accum.values()].sort((a, b) => b.score - a.score);
  return opts.limit != null ? fused.slice(0, opts.limit) : fused;
}
