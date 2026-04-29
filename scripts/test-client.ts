/**
 * MemCore local-stack test client.
 *
 * Wires the SDK to a local OpenAI-compatible LLM (Ollama or LMStudio) and a
 * local embedding model so you can exercise the full ingest → search →
 * profile pipeline without an OPENAI_API_KEY.
 *
 * Defaults assume Ollama on :11434:
 *   LOCAL_LLM_BASE_URL              http://localhost:11434/v1
 *   LOCAL_LLM_MODEL                 qwen2.5:7b              (non-reasoning)
 *   LOCAL_EMBEDDING_BASE_URL        http://localhost:11434/v1
 *   LOCAL_EMBEDDING_MODEL           nomic-embed-text        (768-dim)
 *   LOCAL_ABSTAIN_SIMILARITY_FLOOR  0.55                    (tuned for nomic)
 *
 * The LOCAL_* prefix keeps the test client from inheriting the project's
 * OpenAI-targeted EMBEDDING_MODEL / EMBEDDING_BASE_URL from .env. To point
 * at LMStudio instead:
 *   LOCAL_LLM_BASE_URL=http://localhost:1234/v1
 *   LOCAL_EMBEDDING_BASE_URL=http://localhost:1234/v1
 *
 * Subcommands:
 *   probe         — check the local stack (Ollama / LMStudio / DB schema)
 *   seed          — ingest a canned multi-session corpus into a test container
 *   add <text>    — ingest a one-shot string
 *   search <q>    — query the active container
 *   profile build — (re)generate the container profile
 *   profile get   — fetch the stored profile
 *   e2e           — run the whole round-trip and print a report
 *   reset         — DROP and recreate the schema (destructive)
 *
 * All commands target the container tag `local-test` unless `--tag <name>`
 * is passed.
 *
 * Usage:
 *   pnpm test:client probe
 *   pnpm test:client e2e
 *   pnpm test:client search "what languages do I prefer?"
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { OpenAIEmbedder } from "../src/llm/openai-embedder.js";
import { OpenAILLMClient } from "../src/llm/openai-llm-client.js";
import { MemCore } from "../src/memcore.js";
import { vectorSearchMemories } from "../src/retrieval/memory-search.js";
import { VERSION } from "../src/version.js";

interface ClientConfig {
  databaseUrl: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  abstainSimilarityFloor: number;
  conflictSimilarityThreshold: number;
  containerTag: string;
}

function loadEnvFile(path = ".env"): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadConfig(argv: string[]): ClientConfig {
  loadEnvFile();
  const tagFlagIdx = argv.indexOf("--tag");
  const tag = tagFlagIdx >= 0 ? argv[tagFlagIdx + 1] : null;
  const e = process.env;
  // Use dedicated LOCAL_* env vars for the test client so it doesn't inherit
  // the project's OpenAI-targeted EMBEDDING_MODEL / etc. from .env. Defaults
  // are calibrated to local models: qwen2.5:7b is non-reasoning and large
  // enough to follow the strict-JSON extraction prompt; nomic-embed-text
  // is a small embedder so we raise the abstain floor from 0.3 (tuned to
  // text-embedding-3-large) to 0.55 — small embedders compress the cosine
  // band and most off-topic queries still clear 0.3.
  const floorRaw = e.LOCAL_ABSTAIN_SIMILARITY_FLOOR;
  const floor = floorRaw == null ? 0.65 : Number.parseFloat(floorRaw);
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
    abstainSimilarityFloor: Number.isFinite(floor) ? floor : 0.65,
    conflictSimilarityThreshold: Number.isFinite(conflict) ? conflict : 0.55,
    containerTag: tag || e.MEMCORE_TEST_TAG || "local-test",
  };
}

function buildMemCore(cfg: ClientConfig): MemCore {
  const llmClient = new OpenAILLMClient({
    apiKey: cfg.llmApiKey,
    defaultModel: cfg.llmModel,
    baseUrl: cfg.llmBaseUrl,
  });
  const embedder = new OpenAIEmbedder({
    apiKey: cfg.embeddingApiKey,
    model: cfg.embeddingModel,
    baseUrl: cfg.embeddingBaseUrl,
  });
  return new MemCore({
    databaseUrl: cfg.databaseUrl,
    llmClient,
    embedder,
    extractionModel: cfg.llmModel,
    contextualizerModel: cfg.llmModel,
    conflictModel: cfg.llmModel,
    temporalParserModel: cfg.llmModel,
    profileGeneratorModel: cfg.llmModel,
    abstainSimilarityFloor: cfg.abstainSimilarityFloor,
    conflictSimilarityThreshold: cfg.conflictSimilarityThreshold,
  });
}

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

async function probe(cfg: ClientConfig): Promise<void> {
  console.log(`MemCore test client probe (SDK v${VERSION})`);
  console.log(`  database:        ${cfg.databaseUrl}`);
  console.log(`  llm base url:    ${cfg.llmBaseUrl}`);
  console.log(`  llm model:       ${cfg.llmModel}`);
  console.log(`  embedding url:   ${cfg.embeddingBaseUrl}`);
  console.log(`  embedding model: ${cfg.embeddingModel}`);
  console.log(`  abstain floor:   ${cfg.abstainSimilarityFloor}`);
  console.log(`  container tag:   ${cfg.containerTag}`);
  console.log("");

  // 1. LLM endpoint
  await probeChat(cfg);
  // 2. Embedding endpoint
  const embeddingDim = await probeEmbedding(cfg);
  // 3. Postgres schema
  await probeSchema(cfg);

  console.log(`✓ probe complete (embedding dim: ${embeddingDim ?? "unknown"})`);
}

async function probeChat(cfg: ClientConfig): Promise<void> {
  const url = `${cfg.llmBaseUrl}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.llmApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`✗ chat probe failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return;
    }
    const json = (await res.json()) as {
      choices: { message: { content: string | null } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    console.log(`✓ chat /v1/chat/completions reachable; sample: ${JSON.stringify(text)}`);
    if (!text.trim()) {
      console.log(
        "  ! empty content — your model is likely a reasoning model that burned the token budget on its <think> block. Pick a non-reasoning model like qwen2.5:3b.",
      );
    }
  } catch (err) {
    console.log(`✗ chat probe error: ${(err as Error).message}`);
  }
}

async function probeEmbedding(cfg: ClientConfig): Promise<number | null> {
  const url = `${cfg.embeddingBaseUrl}/embeddings`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.embeddingApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfg.embeddingModel, input: ["hello world"] }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`✗ embedding probe failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
      if (body.includes("not found")) {
        console.log(
          `  → pull the embedding model first:  ollama pull ${cfg.embeddingModel}\n    (or set EMBEDDING_MODEL to one already installed)`,
        );
      }
      return null;
    }
    const json = (await res.json()) as {
      data: { embedding: number[] }[];
    };
    const vec = json.data[0]?.embedding;
    if (!vec) {
      console.log("✗ embedding response had no data");
      return null;
    }
    console.log(`✓ embedding /v1/embeddings reachable; dim=${vec.length}`);
    return vec.length;
  } catch (err) {
    console.log(`✗ embedding probe error: ${(err as Error).message}`);
    return null;
  }
}

async function probeSchema(cfg: ClientConfig): Promise<void> {
  const sql = postgres(cfg.databaseUrl, { onnotice: () => {} });
  try {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const present = new Set(rows.map((r) => r.table_name));
    const required = [
      "containers",
      "conversations",
      "messages",
      "chunks",
      "memories",
      "memory_chunks",
      "edges",
      "profiles",
    ];
    const missing = required.filter((t) => !present.has(t));
    if (missing.length === 0) {
      console.log(`✓ schema OK (${required.length} tables present)`);
    } else {
      console.log(`✗ schema is stale — missing tables: ${missing.join(", ")}`);
      console.log("  → run:  pnpm db:reset   (destructive)");
    }
  } catch (err) {
    console.log(`✗ schema probe error: ${(err as Error).message}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

const SEED_SESSIONS: {
  externalId: string;
  messages: { role: "user" | "assistant"; content: string }[];
}[] = [
  {
    externalId: "session-1-intro",
    messages: [
      {
        role: "user",
        content:
          "Quick intro: I'm Maya, a backend engineer in Brooklyn. My favourite programming language is TypeScript, and I ship side projects on Vercel. Allergic to peanuts.",
      },
      {
        role: "assistant",
        content:
          "Got it, Maya — backend engineer in Brooklyn, favourite language TypeScript, Vercel, peanut allergy noted.",
      },
    ],
  },
  {
    externalId: "session-2-update",
    messages: [
      {
        role: "user",
        content:
          "Update: my favourite programming language is now Rust. I'm not using TypeScript at all anymore — I've moved everything to Rust.",
      },
      {
        role: "assistant",
        content: "Updated your favourite language from TypeScript to Rust; TypeScript is gone.",
      },
    ],
  },
  {
    externalId: "session-3-temporal",
    messages: [
      {
        role: "user",
        content:
          "I'm flying to Tokyo next month for a two-week research trip. Mostly meeting with the embedded-systems team there.",
      },
      { role: "assistant", content: "Logged your Tokyo trip next month." },
    ],
  },
];

async function seed(cfg: ClientConfig): Promise<void> {
  const memcore = buildMemCore(cfg);
  try {
    console.log(`Seeding container "${cfg.containerTag}" with ${SEED_SESSIONS.length} sessions...`);
    for (const session of SEED_SESSIONS) {
      const start = performance.now();
      const result = await memcore.add({
        containerTag: cfg.containerTag,
        externalId: session.externalId,
        messages: session.messages,
      });
      const dt = Math.round(performance.now() - start);
      console.log(
        `  + ${session.externalId.padEnd(22)}  chunks=${result.chunksWritten}  memories=${result.memoriesWritten}  edges=${result.edgesWritten}  superseded=${result.memoriesSuperseded}  dups=${result.duplicatesSkipped}  (${dt}ms)`,
      );
    }
    const totals = memcore.costTracker.total();
    console.log(
      `\n✓ seed complete — ${totals.calls} LLM/embedding calls, ${totals.tokens} tokens, ~$${totals.costUsd.toFixed(4)}`,
    );
  } finally {
    await memcore.close();
  }
}

async function addOne(cfg: ClientConfig, text: string): Promise<void> {
  const memcore = buildMemCore(cfg);
  try {
    const result = await memcore.add({
      containerTag: cfg.containerTag,
      content: text,
      sourceType: "document",
    });
    console.log(pretty(result));
  } finally {
    await memcore.close();
  }
}

async function search(cfg: ClientConfig, query: string): Promise<void> {
  const memcore = buildMemCore(cfg);
  try {
    const start = performance.now();
    const out = await memcore.search({ containerTag: cfg.containerTag, query });
    const dt = Math.round(performance.now() - start);
    console.log(
      `query=${JSON.stringify(query)}  candidates=${out.queryMetadata.totalCandidates}  shouldAbstain=${out.queryMetadata.shouldAbstain}  reason=${out.queryMetadata.abstainReason ?? "n/a"}  profileRelevant=${out.queryMetadata.profileRelevant}  (${dt}ms)`,
    );
    if (out.profile) {
      console.log(`profile (v${out.profile.version}, ${out.profile.sourceMemoryCount} memories):`);
      console.log(`  ${out.profile.content.replace(/\n/g, "\n  ")}\n`);
    }
    for (const r of out.results) {
      const m = r.memory;
      const related = r.relatedMemories.length ? `  (+${r.relatedMemories.length} related)` : "";
      console.log(
        `  - [${m.category}/${m.status}] score=${r.score.toFixed(3)}  ${m.content}${related}`,
      );
    }
    if (out.results.length === 0) {
      console.log("  (no results)");
    }
  } finally {
    await memcore.close();
  }
}

async function buildProfile(cfg: ClientConfig): Promise<void> {
  const memcore = buildMemCore(cfg);
  try {
    const profile = await memcore.buildProfile({ containerTag: cfg.containerTag });
    if (!profile) {
      console.log("✗ no profile built — no active memories yet, or no LLM client configured");
      return;
    }
    console.log(
      `✓ profile v${profile.version} built from ${profile.sourceMemoryCount} memories using ${profile.generatorModel}`,
    );
    console.log("---");
    console.log(profile.content);
    console.log("---");
  } finally {
    await memcore.close();
  }
}

async function getProfile(cfg: ClientConfig): Promise<void> {
  const memcore = buildMemCore(cfg);
  try {
    const profile = await memcore.getProfile({ containerTag: cfg.containerTag });
    if (!profile) {
      console.log("✗ no profile stored yet — run `pnpm test:client profile build` first");
      return;
    }
    console.log(`profile v${profile.version} (${profile.sourceMemoryCount} memories)`);
    console.log("---");
    console.log(profile.content);
  } finally {
    await memcore.close();
  }
}

async function clearContainer(cfg: ClientConfig): Promise<void> {
  const sql = postgres(cfg.databaseUrl, { onnotice: () => {} });
  try {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM containers WHERE tag = ${cfg.containerTag} RETURNING id
    `;
    console.log(
      rows[0]
        ? `✓ cleared container "${cfg.containerTag}"`
        : `(no container "${cfg.containerTag}" to clear)`,
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function e2e(cfg: ClientConfig): Promise<void> {
  console.log(`=== e2e against ${cfg.llmBaseUrl} (${cfg.llmModel}) ===\n`);
  await probe(cfg);
  console.log("");

  await clearContainer(cfg);
  console.log("");

  await seed(cfg);
  console.log("");

  const memcore = buildMemCore(cfg);
  try {
    const queries: { label: string; query: string }[] = [
      { label: "recall", query: "What languages does the user prefer for side projects?" },
      {
        label: "knowledge update",
        query: "What language does the user use for side projects now?",
      },
      { label: "temporal", query: "Where is the user travelling next month?" },
      { label: "profile-relevant", query: "What do you know about me?" },
      { label: "abstain", query: "What is the user's blood type?" },
    ];
    console.log("=== queries ===");
    for (const q of queries) {
      const start = performance.now();
      const out = await memcore.search({ containerTag: cfg.containerTag, query: q.query });
      const dt = Math.round(performance.now() - start);
      const top = out.results[0];
      const topScore = top?.score?.toFixed(3) ?? "n/a";
      const profileTag = out.profile ? ` profile=v${out.profile.version}` : "";
      const profileRel = out.queryMetadata.profileRelevant ? " profile_relevant=true" : "";
      console.log(
        `\n[${q.label}] ${q.query}  (${dt}ms, candidates=${out.queryMetadata.totalCandidates}, abstain=${out.queryMetadata.shouldAbstain}${out.queryMetadata.abstainReason ? `/${out.queryMetadata.abstainReason}` : ""}, top_score=${topScore}${profileRel}${profileTag})`,
      );
      if (top) {
        console.log(`  → top: [${top.memory.category}/${top.memory.status}] ${top.memory.content}`);
      } else {
        console.log("  → (no results)");
      }
    }

    console.log("\n=== profile build ===");
    const profile = await memcore.buildProfile({ containerTag: cfg.containerTag });
    if (profile) {
      console.log(`v${profile.version} from ${profile.sourceMemoryCount} memories:`);
      console.log(profile.content);
    } else {
      console.log("(no profile produced — likely no active memories)");
    }

    const totals = memcore.costTracker.total();
    console.log(
      `\n=== totals ===\n  calls: ${totals.calls}\n  tokens: ${totals.tokens}\n  cost: ~$${totals.costUsd.toFixed(4)} (local models report 0 if unpriced)`,
    );
  } finally {
    await memcore.close();
  }
}

async function diagnose(cfg: ClientConfig, query: string): Promise<void> {
  const sql = postgres(cfg.databaseUrl, { onnotice: () => {} });
  const embedder = new OpenAIEmbedder({
    apiKey: cfg.embeddingApiKey,
    model: cfg.embeddingModel,
    baseUrl: cfg.embeddingBaseUrl,
  });
  try {
    const containerRow = await sql<{ id: string }[]>`
      SELECT id FROM containers WHERE tag = ${cfg.containerTag} LIMIT 1
    `;
    if (!containerRow[0]) {
      console.log(`(no container "${cfg.containerTag}" — run seed first)`);
      return;
    }
    const containerId = containerRow[0].id;
    const emb = await embedder.embed({ texts: [query] });
    const queryVector = emb.vectors[0];
    if (!queryVector) {
      console.log("✗ embedder returned no vector");
      return;
    }
    const hits = await vectorSearchMemories(sql, {
      containerId,
      queryVector,
      limit: 5,
      includeChunks: false,
    });
    console.log(
      `query=${JSON.stringify(query)}  embedding_dim=${queryVector.length}  abstain_floor=${cfg.abstainSimilarityFloor}`,
    );
    if (hits.length === 0) {
      console.log("  (no memories — corpus is empty)");
      return;
    }
    for (const h of hits) {
      const flag = h.score < cfg.abstainSimilarityFloor ? " ← below floor" : "";
      console.log(`  ${h.score.toFixed(4)}  [${h.category}] ${h.content}${flag}`);
    }
    const topAbstain = (hits[0]?.score ?? 0) < cfg.abstainSimilarityFloor;
    console.log(`\nwould abstain: ${topAbstain}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function reset(cfg: ClientConfig): Promise<void> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const schemaPath = resolve(here, "..", "db", "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");
  const sql = postgres(cfg.databaseUrl, { onnotice: () => {} });
  try {
    console.log(`applying ${schemaPath}`);
    await sql.unsafe(schemaSql);
    // Drop legacy alembic_version table if it lingers from the Python era.
    await sql`DROP TABLE IF EXISTS alembic_version`;
    console.log("✓ schema reset");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function usage(): void {
  console.log(
    [
      "Usage: pnpm test:client <command> [args...] [--tag <name>]",
      "",
      "Commands:",
      "  probe                       check local LLM/embedder/DB",
      "  reset                       drop + recreate the schema (destructive)",
      "  seed                        seed the canned multi-session corpus",
      "  add <text>                  ingest a one-off string",
      '  search "<query>"            search the active container',
      "  profile build               (re)generate the container profile",
      "  profile get                 fetch the stored profile",
      "  e2e                         clear, seed, query, profile, report",
      '  diagnose "<query>"          show raw vector cosine scores for top hits',
      "",
      "Env (with defaults):",
      "  DATABASE_URL          postgresql://postgres:postgres@localhost:5433/memcore",
      "  LLM_BASE_URL          http://localhost:11434/v1",
      "  LLM_MODEL             qwen2.5:3b",
      "  EMBEDDING_BASE_URL    http://localhost:11434/v1",
      "  EMBEDDING_MODEL       nomic-embed-text",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const cfg = loadConfig(argv);

  switch (cmd) {
    case "probe":
      await probe(cfg);
      return;
    case "reset":
      await reset(cfg);
      return;
    case "seed":
      await seed(cfg);
      return;
    case "add": {
      const text = argv
        .slice(1)
        .filter((a) => a !== "--tag" && !a.startsWith("--tag="))
        .join(" ");
      if (!text) throw new Error("add requires content text");
      await addOne(cfg, text);
      return;
    }
    case "search": {
      const q = argv
        .slice(1)
        .filter((a) => a !== "--tag" && !a.startsWith("--tag="))
        .join(" ");
      if (!q) throw new Error('search requires a query, e.g. search "what do I prefer?"');
      await search(cfg, q);
      return;
    }
    case "profile": {
      const sub = argv[1];
      if (sub === "build") return buildProfile(cfg);
      if (sub === "get") return getProfile(cfg);
      throw new Error("profile requires 'build' or 'get'");
    }
    case "diagnose": {
      const q = argv
        .slice(1)
        .filter((a) => a !== "--tag" && !a.startsWith("--tag="))
        .join(" ");
      if (!q) throw new Error('diagnose requires a query, e.g. diagnose "blood type"');
      await diagnose(cfg, q);
      return;
    }
    case "e2e":
      await e2e(cfg);
      return;
    default:
      usage();
      if (cmd) process.exit(2);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
