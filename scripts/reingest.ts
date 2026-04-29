/**
 * Re-generate contextual prefixes (and re-embed) for chunks that were ingested
 * before the contextualizer existed (or before a prompt bump). Groups chunks by
 * source so the contextualizer sees the same `<session>` prefix across every
 * chunk in a session — the prompt-cache shape from
 * `src/ingestion/contextualizer.ts`.
 *
 *   pnpm tsx scripts/reingest.ts                  # all chunks missing a prefix
 *   pnpm tsx scripts/reingest.ts --all            # every chunk, regardless of prefix
 *   pnpm tsx scripts/reingest.ts --container user_42
 *   pnpm tsx scripts/reingest.ts --dry-run        # report counts, change nothing
 *
 * Flow per chunk:
 *   1. Reconstruct the source session text — for conversation chunks, replay
 *      `messages` ordered by position; for everything else fall back to a
 *      string of all chunks for that conversation/source.
 *   2. Call contextualizer for the chunk.
 *   3. Re-embed `prefix + content`.
 *   4. UPDATE chunks SET contextual_prefix, embedding.
 *
 * Memories are not re-extracted here — that's a different, more expensive
 * operation guarded by the prompt_version field. This script stays narrowly
 * focused on the contextual_prefix backfill called out in ROADMAP § Phase 3.
 */

import { getSettings } from "../src/config.js";
import { closePool, getPool } from "../src/db/pool.js";
import { vectorLiteral } from "../src/db/vector.js";
import { contextualizeChunks } from "../src/ingestion/contextualizer.js";
import { OpenAIEmbedder } from "../src/llm/openai-embedder.js";
import { OpenAILLMClient } from "../src/llm/openai-llm-client.js";
import { getLogger } from "../src/logging.js";

const logger = getLogger("scripts.reingest");

interface Args {
  all: boolean;
  containerTag: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, containerTag: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--container") args.containerTag = argv[++i] ?? null;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

interface ChunkRow {
  id: string;
  container_id: string;
  conversation_id: string | null;
  content: string;
  contextual_prefix: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const settings = getSettings();
  const sql = getPool();

  const apiKey = settings.embeddingApiKey ?? settings.openaiApiKey;
  if (!apiKey) {
    logger.error("no OPENAI_API_KEY / EMBEDDING_API_KEY set; cannot re-embed");
    await closePool();
    process.exit(2);
  }
  const llmKey = settings.openaiApiKey;
  if (!llmKey && !args.dryRun) {
    logger.error("no OPENAI_API_KEY set; cannot run contextualizer");
    await closePool();
    process.exit(2);
  }

  const embedder = new OpenAIEmbedder({
    apiKey,
    model: settings.embeddingModel,
    ...(settings.embeddingBaseUrl ? { baseUrl: settings.embeddingBaseUrl } : {}),
  });
  const llm = llmKey
    ? new OpenAILLMClient({ apiKey: llmKey, defaultModel: settings.contextualizerModel })
    : null;

  // Collect candidate chunks. We group by conversation_id later so the prompt
  // prefix (the session text) is identical across calls within a group.
  const containerFilter = args.containerTag ? sql`AND co.tag = ${args.containerTag}` : sql``;
  const prefixFilter = args.all ? sql`` : sql`AND c.contextual_prefix IS NULL`;

  const rows = await sql<ChunkRow[]>`
    SELECT c.id, c.container_id, c.conversation_id, c.content, c.contextual_prefix
    FROM chunks c
    JOIN containers co ON co.id = c.container_id
    WHERE 1=1
      ${prefixFilter}
      ${containerFilter}
    ORDER BY c.conversation_id NULLS LAST, c.position
  `;

  logger.info({ count: rows.length, dryRun: args.dryRun }, "reingest_candidates");
  if (args.dryRun || rows.length === 0) {
    await closePool();
    return;
  }

  // Group by conversation_id. Null conversation_id chunks each form their own
  // "session" of one chunk.
  const groups = new Map<string, ChunkRow[]>();
  for (const r of rows) {
    const key = r.conversation_id ?? `chunk:${r.id}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  let updated = 0;
  for (const [key, group] of groups) {
    const sessionText = await buildSessionText(sql, group, key);
    const chunks = group.map((r) => ({
      content: r.content,
      // Token count is not stored; encode here. The contextualizer skip
      // threshold is small so the cost is negligible vs the LLM call.
      tokenCount: approxTokenCount(r.content),
    }));

    const prefixes = llm
      ? await contextualizeChunks(
          { llm, model: settings.contextualizerModel },
          { sessionText, chunks },
        )
      : new Array(group.length).fill(null);

    const embeddings = await embedder.embed({
      texts: group.map((r, i) => {
        const p = prefixes[i];
        return p ? `${p}\n\n${r.content}` : r.content;
      }),
    });

    for (let i = 0; i < group.length; i += 1) {
      const row = group[i];
      const vec = embeddings.vectors[i];
      const prefix = prefixes[i] ?? null;
      if (!row || !vec) continue;
      await sql`
        UPDATE chunks
        SET contextual_prefix = ${prefix},
            embedding = ${vectorLiteral(vec)}::vector
        WHERE id = ${row.id}
      `;
      updated += 1;
    }
  }

  logger.info({ updated }, "reingest_complete");
  await closePool();
}

async function buildSessionText(
  sql: ReturnType<typeof getPool>,
  group: ChunkRow[],
  key: string,
): Promise<string> {
  // For conversation chunks, prefer the original messages (they're closer to
  // the LLM's input contract than a concat of post-chunked text).
  if (key.startsWith("chunk:")) {
    return group[0]?.content ?? "";
  }
  const messages = await sql<{ role: string; content: string }[]>`
    SELECT role, content FROM messages
    WHERE conversation_id = ${key}
    ORDER BY position ASC
  `;
  if (messages.length > 0) {
    return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  }
  // No stored messages (document-style ingestion). Concat chunks in order.
  return group.map((r) => r.content).join("\n\n");
}

function approxTokenCount(text: string): number {
  // The chunker uses gpt-tokenizer; we don't need precision here, just a rough
  // proxy for the short-chunk skip. ~4 chars per token is a fine ballpark for
  // English; the threshold in the contextualizer is 50 tokens (≈200 chars).
  return Math.ceil(text.length / 4);
}

main().catch(async (err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "reingest_failed");
  await closePool();
  process.exit(1);
});
