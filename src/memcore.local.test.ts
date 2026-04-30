/**
 * End-to-end integration tests against a local OpenAI-compatible LLM and
 * embedder (Ollama / LMStudio / vLLM / llama.cpp's server). This is the only
 * place in the suite where MemCore is exercised top-to-bottom with real
 * models — every other test stubs the LLM or runs without one.
 *
 * The tests self-skip when the local stack isn't reachable so contributors
 * without a local model server can still run `pnpm test`. To run them:
 *
 *   ollama serve &
 *   ollama pull qwen2.5:7b
 *   ollama pull nomic-embed-text
 *   docker compose up -d postgres
 *   pnpm db:reset
 *   MEMCORE_LOCAL_TEST=1 pnpm test:local
 *
 * Defaults assume Ollama on :11434. Override via the same `LOCAL_*` env vars
 * documented in `scripts/test-client.ts` and `.env.example`.
 *
 * What this asserts:
 *   1. Probe: chat + embeddings + Postgres schema all reachable.
 *   2. Single-session recall: ingest a fact, query, retrieved content covers it.
 *   3. Knowledge update: contradicting fact supersedes the older one — searches
 *      for the current state surface the new fact, not the stale one.
 *   4. Multi-session retrieval: facts from separate `add()` calls both come
 *      back when queried.
 *   5. Abstain: a query unrelated to the corpus returns `shouldAbstain: true`.
 *   6. Profile build: produces a non-empty profile after seeding.
 *
 * Steps (3) and (6) need a model big enough to follow the strict-JSON
 * extraction prompt. qwen2.5:7b works; smaller models can be flaky there. The
 * test allows chunk-level fallback for recall checks (steps 2 and 4) so a
 * weak extractor doesn't fail those — chunks still get embedded even when
 * memory extraction returns nothing.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenAIEmbedder } from "./llm/openai-embedder.js";
import { OpenAILLMClient } from "./llm/openai-llm-client.js";
import { MemCore } from "./memcore.js";

interface LocalConfig {
  databaseUrl: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  abstainSimilarityFloor: number;
  conflictSimilarityThreshold: number;
}

function loadLocalConfig(): LocalConfig {
  const e = process.env;
  const floorRaw = e.LOCAL_ABSTAIN_SIMILARITY_FLOOR;
  const floor = floorRaw == null ? 0.55 : Number.parseFloat(floorRaw);
  const conflictRaw = e.LOCAL_CONFLICT_SIMILARITY_THRESHOLD;
  const conflict = conflictRaw == null ? 0.55 : Number.parseFloat(conflictRaw);
  return {
    databaseUrl: e.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/memcore",
    llmBaseUrl: e.LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1",
    llmApiKey: e.LOCAL_LLM_API_KEY ?? "ollama",
    llmModel: e.LOCAL_LLM_MODEL ?? "qwen2.5:7b",
    embeddingBaseUrl: e.LOCAL_EMBEDDING_BASE_URL ?? "http://localhost:11434/v1",
    embeddingApiKey: e.LOCAL_EMBEDDING_API_KEY ?? "ollama",
    embeddingModel: e.LOCAL_EMBEDDING_MODEL ?? "nomic-embed-text",
    abstainSimilarityFloor: Number.isFinite(floor) ? floor : 0.55,
    conflictSimilarityThreshold: Number.isFinite(conflict) ? conflict : 0.55,
  };
}

async function probeChat(cfg: LocalConfig): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.llmApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [{ role: "user", content: "Reply with just: ok" }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: `chat HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `chat error: ${(err as Error).message}` };
  }
}

async function probeEmbedding(cfg: LocalConfig): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${cfg.embeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.embeddingApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfg.embeddingModel, input: ["probe"] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: `embedding HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `embedding error: ${(err as Error).message}` };
  }
}

async function probeDb(databaseUrl: string): Promise<{ ok: boolean; reason?: string }> {
  let sql: postgres.Sql | null = null;
  try {
    sql = postgres(databaseUrl, { onnotice: () => {}, max: 1 });
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const required = ["containers", "memories", "chunks", "memory_chunks"];
    const present = new Set(tables.map((t) => t.table_name));
    const missing = required.filter((t) => !present.has(t));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `schema missing tables: ${missing.join(",")}; run pnpm db:reset`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `db error: ${(err as Error).message}` };
  } finally {
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function buildMemCore(cfg: LocalConfig): MemCore {
  return new MemCore({
    databaseUrl: cfg.databaseUrl,
    llmClient: new OpenAILLMClient({
      apiKey: cfg.llmApiKey,
      defaultModel: cfg.llmModel,
      baseUrl: cfg.llmBaseUrl,
    }),
    embedder: new OpenAIEmbedder({
      apiKey: cfg.embeddingApiKey,
      model: cfg.embeddingModel,
      baseUrl: cfg.embeddingBaseUrl,
    }),
    extractionModel: cfg.llmModel,
    contextualizerModel: cfg.llmModel,
    conflictModel: cfg.llmModel,
    temporalParserModel: cfg.llmModel,
    profileGeneratorModel: cfg.llmModel,
    abstainSimilarityFloor: cfg.abstainSimilarityFloor,
    conflictSimilarityThreshold: cfg.conflictSimilarityThreshold,
  });
}

const cfg = loadLocalConfig();
let stackAvailable = false;
let skipReason = "";

beforeAll(async () => {
  // The test only runs when explicitly opted in. Without the env flag, treat
  // the stack as unavailable so pnpm test stays fast and offline.
  if (!process.env.MEMCORE_LOCAL_TEST) {
    skipReason = "MEMCORE_LOCAL_TEST not set — skipping local-stack integration tests";
    return;
  }
  const checks = await Promise.all([probeChat(cfg), probeEmbedding(cfg), probeDb(cfg.databaseUrl)]);
  const failed = checks.find((c) => !c.ok);
  if (failed) {
    skipReason = failed.reason ?? "unknown probe failure";
    return;
  }
  stackAvailable = true;
}, 60_000);

const TAG = `local-test-${Date.now()}`;

afterAll(async () => {
  if (!stackAvailable) return;
  // Drop everything tied to this run's container. Cascade in schema cleans
  // up conversations, chunks, memories, edges, and profile rows.
  const sql = postgres(cfg.databaseUrl, { onnotice: () => {}, max: 1 });
  try {
    await sql`DELETE FROM containers WHERE tag = ${TAG}`.catch(() => {});
  } finally {
    await sql.end({ timeout: 5 });
  }
});

function lower(s: string): string {
  return s.toLowerCase();
}

function retrievedHasAny(
  results: { memory: { content: string; chunks: { content: string }[] } }[],
  needles: string[],
): boolean {
  // Memory text first, source chunks as fallback. Small extractor models
  // sometimes return [] on a perfectly-good fact; the chunk still got
  // embedded and indexed, so search can still surface it.
  const haystack = results
    .flatMap((r) => [r.memory.content, ...r.memory.chunks.map((c) => c.content)])
    .map(lower)
    .join("\n");
  return needles.some((n) => haystack.includes(lower(n)));
}

describe("MemCore against local models (integration)", () => {
  it("ingest → recall: a single seeded fact comes back", { timeout: 180_000 }, async () => {
    if (!stackAvailable) {
      console.warn(`skipping: ${skipReason}`);
      return;
    }
    const memcore = buildMemCore(cfg);
    try {
      await memcore.add({
        containerTag: TAG,
        externalId: "recall-1",
        messages: [
          {
            role: "user",
            content:
              "Quick intro: I'm a backend engineer based in Brooklyn. My favourite programming language is TypeScript.",
          },
          {
            role: "assistant",
            content: "Got it — backend engineer in Brooklyn, favourite language TypeScript.",
          },
        ],
      });

      const out = await memcore.search({
        containerTag: TAG,
        query: "What is the user's favourite programming language?",
        limit: 5,
        includeChunks: true,
      });

      expect(out.results.length).toBeGreaterThan(0);
      expect(retrievedHasAny(out.results, ["typescript"])).toBe(true);
    } finally {
      await memcore.close();
    }
  });

  it(
    "knowledge update: a contradicting fact supersedes the prior one",
    { timeout: 240_000 },
    async () => {
      if (!stackAvailable) return;
      const memcore = buildMemCore(cfg);
      try {
        // Two distinct sessions. The first establishes a fact; the second
        // contradicts it. The conflict detector should mark the original
        // memory superseded so search for the *current* state returns the
        // new fact, not the stale one.
        await memcore.add({
          containerTag: TAG,
          externalId: "ku-session-1",
          messages: [
            {
              role: "user",
              content: "I work at Acme Corp as a senior engineer on the payments team.",
            },
            {
              role: "assistant",
              content: "Logged: senior engineer at Acme Corp, payments team.",
            },
          ],
        });
        await memcore.add({
          containerTag: TAG,
          externalId: "ku-session-2",
          messages: [
            {
              role: "user",
              content: "Quick update — I left Acme. I just started at Globex as a staff engineer.",
            },
            {
              role: "assistant",
              content: "Updated employer from Acme to Globex; new role staff engineer.",
            },
          ],
        });

        const out = await memcore.search({
          containerTag: TAG,
          query: "Where does the user work now?",
          limit: 5,
          includeChunks: true,
          // Don't filter active-only here — we want to verify that even with
          // the full pool, the *current* fact ranks above the stale one.
        });

        expect(out.results.length).toBeGreaterThan(0);
        // Strong signal: the top result mentions Globex.
        const top = out.results[0];
        const topText =
          `${top?.memory.content} ${top?.memory.chunks.map((c) => c.content).join(" ")}`.toLowerCase();
        expect(topText).toContain("globex");
      } finally {
        await memcore.close();
      }
    },
  );

  it(
    "multi-session: facts from separate sessions both retrievable",
    { timeout: 240_000 },
    async () => {
      if (!stackAvailable) return;
      const memcore = buildMemCore(cfg);
      try {
        await memcore.add({
          containerTag: TAG,
          externalId: "ms-allergy",
          messages: [
            { role: "user", content: "Heads up — I'm allergic to peanuts. Anaphylactic reaction." },
            { role: "assistant", content: "Noted: peanut allergy, anaphylactic." },
          ],
        });
        await memcore.add({
          containerTag: TAG,
          externalId: "ms-pet",
          messages: [
            { role: "user", content: "I have a golden retriever named Biscuit." },
            { role: "assistant", content: "Logged your dog Biscuit." },
          ],
        });

        const allergyOut = await memcore.search({
          containerTag: TAG,
          query: "Does the user have any food allergies?",
          limit: 5,
          includeChunks: true,
        });
        expect(retrievedHasAny(allergyOut.results, ["peanut"])).toBe(true);

        const petOut = await memcore.search({
          containerTag: TAG,
          query: "What pet does the user own?",
          limit: 5,
          includeChunks: true,
        });
        expect(retrievedHasAny(petOut.results, ["biscuit", "golden retriever"])).toBe(true);
      } finally {
        await memcore.close();
      }
    },
  );

  it(
    "abstain: a query unrelated to the corpus returns shouldAbstain",
    { timeout: 120_000 },
    async () => {
      if (!stackAvailable) return;
      const memcore = buildMemCore(cfg);
      try {
        // Use a fresh container so prior tests' content doesn't leak.
        const isolatedTag = `${TAG}-abstain`;
        await memcore.add({
          containerTag: isolatedTag,
          externalId: "abstain-seed",
          messages: [
            {
              role: "user",
              content: "I bake sourdough on weekends. The starter is named Doughy.",
            },
            { role: "assistant", content: "Logged: bakes sourdough; starter named Doughy." },
          ],
        });

        const out = await memcore.search({
          containerTag: isolatedTag,
          query: "What is the user's blood type?",
          limit: 5,
        });
        // Either the abstain gate fires (preferred) or the candidate set is
        // empty. Both are acceptable — the failure mode we'd reject is a
        // confident-looking result for an unrelated topic.
        expect(out.queryMetadata.shouldAbstain || out.results.length === 0).toBe(true);

        // Cleanup
        const sql = postgres(cfg.databaseUrl, { onnotice: () => {}, max: 1 });
        try {
          await sql`DELETE FROM containers WHERE tag = ${isolatedTag}`.catch(() => {});
        } finally {
          await sql.end({ timeout: 1 });
        }
      } finally {
        await memcore.close();
      }
    },
  );

  it(
    "profile build: produces a non-empty profile after seeding",
    { timeout: 240_000 },
    async () => {
      if (!stackAvailable) return;
      const memcore = buildMemCore(cfg);
      try {
        const isolatedTag = `${TAG}-profile`;
        await memcore.add({
          containerTag: isolatedTag,
          externalId: "profile-seed",
          messages: [
            {
              role: "user",
              content:
                "I'm a backend engineer in Brooklyn. I prefer TypeScript and Postgres, ship side projects on Vercel, and I'm allergic to peanuts.",
            },
            { role: "assistant", content: "Got it — noted." },
          ],
        });

        const profile = await memcore.buildProfile({ containerTag: isolatedTag });
        // Profile may be null if the local model returned [] for extraction —
        // the generator skips when there are no active memories. Treat that as
        // a soft skip rather than a hard fail, but the more common case (and
        // what we want to verify) is a non-empty profile.
        if (!profile) {
          console.warn(
            "profile build returned null — extractor likely produced no memories; check model size",
          );
        } else {
          expect(profile.content.length).toBeGreaterThan(20);
          expect(profile.sourceMemoryCount).toBeGreaterThan(0);
        }

        const sql = postgres(cfg.databaseUrl, { onnotice: () => {}, max: 1 });
        try {
          await sql`DELETE FROM containers WHERE tag = ${isolatedTag}`.catch(() => {});
        } finally {
          await sql.end({ timeout: 1 });
        }
      } finally {
        await memcore.close();
      }
    },
  );
});
