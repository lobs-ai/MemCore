/**
 * Eval runner. Reads JSONL cases, drives a fresh `MemCore` instance per case
 * (isolated container), and reports retrieval-style accuracy.
 *
 *   pnpm eval                                # runs all categories
 *   pnpm eval -- --category single_session_recall
 *   pnpm eval -- --output report.json
 *
 * Phase 1 scoring is `contains`: a case passes if the expected answer string
 * appears (case-insensitive) in any of the top-k retrieved chunks. This is a
 * loose proxy for end-to-end answer quality and will be replaced with an
 * LLM-grader once we have memories (Phase 2+).
 *
 * The runner needs a real embedder to be meaningful. With OPENAI_API_KEY
 * unset it falls back to the stub and the numbers are noise — the harness
 * still runs so plumbing changes are caught early.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getSettings } from "../src/config.js";
import { getLogger } from "../src/logging.js";
import { MemCore } from "../src/memcore.js";
import { type Report, aggregate } from "./metrics.js";
import type { EvalCase, EvalResult } from "./types.js";

const logger = getLogger("evals.runner");

interface RunnerArgs {
  category: string | null;
  outputPath: string | null;
}

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = { category: null, outputPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--category") args.category = argv[++i] ?? null;
    else if (a === "--output") args.outputPath = argv[++i] ?? null;
  }
  return args;
}

function loadCases(category: string | null): EvalCase[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dir = resolve(here, "cases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const cases: EvalCase[] = [];
  for (const file of files) {
    const baseName = file.replace(/\.jsonl$/, "");
    if (category && baseName !== category) continue;
    const raw = readFileSync(resolve(dir, file), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      cases.push(JSON.parse(trimmed) as EvalCase);
    }
  }
  return cases;
}

function score(
  c: EvalCase,
  retrievedContents: string[],
  shouldAbstain: boolean,
  resultsCount: number,
): boolean {
  // Abstain category: the answer is "I don't know". The search path is
  // expected to flag the query as unanswerable from memory, OR (equivalently)
  // return zero results. Surfacing memory content for an abstain case is the
  // failure mode we care about here — that's a hallucination risk downstream.
  if (c.scoring === "abstain" || c.category === "abstain") {
    return shouldAbstain || resultsCount === 0;
  }
  const expected = c.expected_answer.toLowerCase();
  if (c.scoring === "contains") {
    return retrievedContents.some((s) => s.toLowerCase().includes(expected));
  }
  return retrievedContents.some((s) => s.toLowerCase() === expected);
}

async function runCase(memcore: MemCore, containerTag: string, c: EvalCase): Promise<EvalResult> {
  // All cases share one container so each query competes against every other
  // case's setup. Without that, top-k = "the only chunk you ingested" and the
  // eval is trivially 100%.
  const start = performance.now();
  const result = await memcore.search({
    containerTag,
    query: c.question,
    limit: 5,
    includeChunks: true,
  });
  const latencyMs = Math.round(performance.now() - start);
  // Phase 2: score the memory content first; fall back to source chunks so
  // the metric still works even when extraction returned [] for the relevant
  // material (chunk-only fallback path).
  const retrievedContents = result.results.flatMap((r) => [
    r.memory.content,
    ...r.memory.chunks.map((ch) => ch.content),
  ]);
  const shouldAbstain = result.queryMetadata.shouldAbstain;
  const passed = score(c, retrievedContents, shouldAbstain, result.results.length);

  return {
    case_id: c.case_id,
    category: c.category,
    passed,
    retrievedTopK: result.results.map((r) => ({ content: r.memory.content, score: r.score })),
    latencyMs,
    shouldAbstain,
  };
}

function printReport(report: Report): void {
  console.log("\n=== Eval report ===");
  console.log(
    `Overall: ${report.overall.passed}/${report.overall.total} (${(
      report.overall.accuracy * 100
    ).toFixed(1)}%)`,
  );
  for (const c of report.byCategory) {
    console.log(
      `  ${c.category}: ${c.passed}/${c.total} (${(c.accuracy * 100).toFixed(1)}%) ` +
        `p50=${c.p50LatencyMs}ms p95=${c.p95LatencyMs}ms`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const settings = getSettings();
  const cases = loadCases(args.category);
  if (cases.length === 0) {
    logger.warn({ category: args.category }, "no eval cases found");
    return;
  }
  logger.info({ count: cases.length, category: args.category }, "running eval cases");

  const memcore = new MemCore({
    databaseUrl: settings.databaseUrl,
    openaiApiKey: settings.openaiApiKey,
    embeddingApiKey: settings.embeddingApiKey,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDim: settings.embeddingDim,
    extractionModel: settings.extractionModel,
    contextualizerModel: settings.contextualizerModel,
    cohereApiKey: settings.cohereApiKey,
    chunkMaxTokens: settings.chunkMaxTokens,
    chunkMinTokens: settings.chunkMinTokens,
  });

  // Shared container per run so cases compete against each other at retrieval.
  const containerTag = `eval_run_${Date.now()}`;

  const results: EvalResult[] = [];
  try {
    // Ingest every case's setup first. Cases with `setup_sessions` ingest
    // each session as its own conversation so the conflict detector and
    // multi-session retrieval are exercised end-to-end.
    for (const c of cases) {
      if (c.setup_sessions && c.setup_sessions.length > 0) {
        for (let i = 0; i < c.setup_sessions.length; i += 1) {
          const session = c.setup_sessions[i];
          if (!session || session.length === 0) continue;
          await memcore.add({
            containerTag,
            messages: session,
            externalId: `${c.case_id}-session-${i}`,
          });
        }
      } else if (c.setup && c.setup.length > 0) {
        await memcore.add({
          containerTag,
          messages: c.setup,
          externalId: `${c.case_id}-setup`,
        });
      }
    }

    // Then query each.
    for (const c of cases) {
      const result = await runCase(memcore, containerTag, c);
      results.push(result);
      logger.info(
        { caseId: c.case_id, passed: result.passed, latencyMs: result.latencyMs },
        result.passed ? "case_pass" : "case_fail",
      );
    }
  } finally {
    await memcore.close();
  }

  const report = aggregate(results);
  printReport(report);
  if (args.outputPath) {
    writeFileSync(args.outputPath, JSON.stringify({ report, results }, null, 2), "utf8");
    logger.info({ path: args.outputPath }, "report_written");
  }
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "eval_runner_failed");
  process.exit(1);
});
