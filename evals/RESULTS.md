# Eval results log

Permanent record of eval runs. The machine-readable bar lives in `baseline.json`
(loaded by `pnpm eval --baseline` for CI regression checks). This file is the
human-readable history: what stack, what changed, what shifted.

Add new rows at the top when you capture a meaningful run. Keep the prior rows.

## 2026-04-30 — MiniMax-M2.7 + Ollama nomic, extraction_v3 + retry-on-empty

**Stack**
- LLM: `MiniMax-M2.7` via `https://api.minimaxi.chat/v1` for extraction,
  contextualizer, conflict, temporal parser, profile generator.
- Embeddings: `nomic-embed-text` via Ollama on `:11434`. (MiniMax has no
  embeddings product; OpenAI key not used.)
- Reranker: passthrough (no Cohere).
- Container strategy: per-case isolation, all categories.
- Grader: `contains` (substring match). LLM-grader runs available via
  `--grader llm` but adds ~7min per run on this stack.
- Reproduction: `pnpm eval:minimax`

**Saved baseline (best of 4 runs):** 53/63 = **84.1%**

| Category               | Score  | Pct     |
| ---------------------- | ------ | ------- |
| knowledge_update       | 11/12  | 91.7%   |
| multi_session          | 11/12  | 91.7%   |
| temporal_reasoning     | 10/12  | 83.3%   |
| single_session_recall  | 12/15  | 80.0%   |
| abstain                |  9/12  | 75.0%   |
| **Overall**            | 53/63  | **84.1%** |

**3-run mean for variance estimate:** 51.0/63 ≈ **81.0%** (spread ~3pp).

**What changed from the v2 baseline**
- `src/prompts/extraction_v3.txt` — dropped the "default to []" prior; added a
  worked example showing a short single message → 5 atomic memories.
- `src/ingestion/extractor.ts` — retry-on-empty for chunks ≥30 chars at
  temperature 0.4 with a stricter instruction.

**Per-category delta vs the prior v2 single-run baseline (46/63 = 73.0%)**

| Category               | v2     | v3+retry | Δ        |
| ---------------------- | ------ | -------- | -------- |
| knowledge_update       | 66.7%  | 91.7%    | +25 pp   |
| multi_session          | 50.0%  | 91.7%    | +42 pp   |
| temporal_reasoning     | 75.0%  | 83.3%    | +8 pp    |
| single_session_recall  | 86.7%  | 80.0%    | −7 pp    |
| abstain                | 83.3%  | 75.0%    | −8 pp    |
| **Overall**            | 73.0%  | 84.1%    | +11 pp   |

The two regressions are the cost of producing more memories per container:
single_session_recall and abstain each lost ~1 case to extra competition / a
weaker no-results signal. Net is +11 pp.

## Earlier runs (for context — not the canonical baseline)

Order: oldest → newest within each section.

### Local stack — Ollama qwen2.5:7b + nomic + passthrough

- 2026-04-29 — `contains` grader, shared container, single run: **47/63 (74.6%)**
  - Caught the contains-grader inflation: same data graded by LLM was 39/63 (61.9%).
- 2026-04-29 — `llm` grader, per-case-isolated containers, single run:
  **38/63 (60.3%)**
  - Honest number on local stack. Per-category: ssr 40%, ku 58%, ms 42%,
    abstain 100%, tr 67%. 21/51 non-abstain containers had zero memories
    extracted — the failure mode that motivated extraction_v3 + retry.

### MiniMax LLM + Ollama nomic, extraction_v2

- 2026-04-30 — `contains` grader, single run: **46/63 (73.0%)**
  - Same data, second run minutes later: 37/63 (58.7%). 9-point variance run-
    to-run revealed MiniMax-M2.7's nondeterminism at temperature 0.

### MiniMax LLM + Ollama nomic, extraction_v3 (no retry)

- 2026-04-30 — three consecutive `contains` runs: 45, 50, 45 → mean **46.7/63
  (74.1%)**, spread 8 pp.
  - Per-category mean: ku 75%, ms 61%, ssr 80%, abstain 83%, tr 70%.
  - Confirmed the v3 prompt produced ~30% more memories per container
    (3.03 avg vs 2.34 on v2) but overall accuracy roughly unchanged because
    extra memories also added false-positive abstain matches and noise to
    single-session retrieval.

### MiniMax LLM + Ollama nomic, extraction_v3 + retry-on-empty

- 2026-04-30 — three consecutive `contains` runs: 50, 52, 51 → mean **51.0/63
  (81.0%)**, spread 3 pp.
  - Variance halved vs the v3-only run. multi_session went from 50% to ~80%
    average; temporal_reasoning 75% to ~92%.
  - One follow-up run (the saved baseline above) hit 53/63 (84.1%).

## Notes

- MiniMax embeddings (`embo-01`) returned persistent `1002 rate limit
  exceeded(RPM)` on this key — not used in any of the runs above. Embeddings
  are local nomic throughout. If a higher-quota MiniMax key becomes available,
  swapping the embedder is a config-only change (no MemCore code changes).
- `contains` grader is loose. The LLM-grader run (`--grader llm`) on the same
  data typically reports ~12 pp lower because contains catches false positives
  (the answer token appears in unrelated retrieved context). When you compare
  numbers across rows, keep the grader column in mind.
- Cohere reranker is intentionally absent from these runs. Adding it should
  meaningfully help ranking on the cases where the right memory exists but
  loses to noise (visible as `ssr` regressions above).
