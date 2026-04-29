/**
 * Build the right HNSW index over `chunks.embedding` for the configured
 * `EMBEDDING_DIM`. Phase 1 runs without an index (sequential cosine scan is
 * fine for small corpora); call this once you're past a few thousand chunks
 * or before Phase 3's hybrid search lands.
 *
 * pgvector's index types each cap at a different dimensionality:
 *
 *   | Operator class       | Max dims | Notes                                         |
 *   | -------------------- | -------- | --------------------------------------------- |
 *   | vector_cosine_ops    |   2000   | Direct index over the stored `vector`.        |
 *   | halfvec_cosine_ops   |   4000   | Index over `embedding::halfvec(N)`. 16-bit    |
 *   |                      |          | float — recall loss is small (<1pp on most    |
 *   |                      |          | benchmarks), index half the size on disk.     |
 *   | bit_hamming_ops      |  64000   | Index over `binary_quantize(embedding)::bit(N)`. |
 *   |                      |          | Hamming distance is a coarse proxy; treat it  |
 *   |                      |          | as a candidate filter and rerank by exact     |
 *   |                      |          | cosine on the top ~200.                       |
 *
 * Strategy this script picks:
 *
 *   dim ≤ 2000           → HNSW (vector_cosine_ops) over `embedding`
 *   2001 ≤ dim ≤ 4000    → HNSW (halfvec_cosine_ops) over `embedding::halfvec(N)`
 *   dim > 4000           → HNSW (bit_hamming_ops) over `binary_quantize(embedding)::bit(N)`
 *                          (queries must use `<~>` and rerank by exact cosine)
 *
 * Whichever path we pick, queries must use the operator that matches the
 * indexed expression — see SPEC.md § Retrieval pipeline. Re-running this
 * script on a different `EMBEDDING_DIM` drops the previous index first.
 *
 *   Usage: pnpm tsx scripts/create-vector-index.ts
 */

import { getSettings } from "../src/config.js";
import { closePool, getPool } from "../src/db/pool.js";
import { getLogger } from "../src/logging.js";

const logger = getLogger("scripts.create-vector-index");

const INDEX_NAME = "ix_chunks_embedding_ann";

interface Strategy {
  tier: "vector" | "halfvec" | "bit";
  createSql: string;
  queryNote: string;
}

function pickStrategy(dim: number): Strategy {
  if (dim <= 2000) {
    // The column is unbounded `VECTOR` (so we can swap models without DDL),
    // and `vector_cosine_ops` needs a typed dim — so we cast at the index.
    return {
      tier: "vector",
      createSql: `
        CREATE INDEX ${INDEX_NAME} ON chunks
        USING hnsw ((embedding::vector(${dim})) vector_cosine_ops)
      `,
      queryNote:
        "Query with `embedding::vector(N) <=> $vec::vector(N)` so the planner picks this index.",
    };
  }
  if (dim <= 4000) {
    return {
      tier: "halfvec",
      createSql: `
        CREATE INDEX ${INDEX_NAME} ON chunks
        USING hnsw ((embedding::halfvec(${dim})) halfvec_cosine_ops)
      `,
      queryNote:
        "Query with `embedding::halfvec(N) <=> $vec::halfvec(N)` so the planner picks this index.",
    };
  }
  return {
    tier: "bit",
    createSql: `
      CREATE INDEX ${INDEX_NAME} ON chunks
      USING hnsw ((binary_quantize(embedding)::bit(${dim})) bit_hamming_ops)
    `,
    queryNote:
      "Two-stage retrieval: top-N by `binary_quantize(embedding)::bit(N) <~> ...`, then rerank by exact `embedding <=> ...`.",
  };
}

async function main(): Promise<void> {
  const settings = getSettings();
  const dim = settings.embeddingDim;
  const strategy = pickStrategy(dim);
  const pool = getPool();

  logger.info({ dim, tier: strategy.tier }, "creating vector index");

  await pool.unsafe(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  // CREATE INDEX CONCURRENTLY would avoid the table lock but can't run inside
  // a transaction; keep it simple here (the schema is small in early phases).
  await pool.unsafe(strategy.createSql);

  logger.info({ tier: strategy.tier, queryNote: strategy.queryNote }, "vector index ready");
  await closePool();
}

main().catch(async (err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "create_vector_index_failed");
  await closePool();
  process.exit(1);
});
