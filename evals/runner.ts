/**
 * Eval runner. Reads JSONL cases, drives a fresh `MemCore` instance per case
 * (isolated container), and reports retrieval-style accuracy.
 *
 *   pnpm eval                                # runs all categories, contains scorer
 *   pnpm eval -- --category single_session_recall
 *   pnpm eval -- --output report.json
 *   pnpm eval -- --grader llm                # LLM-judge instead of substring match
 *   pnpm eval -- --baseline                  # fail on regression vs evals/baseline.json
 *   pnpm eval -- --update-baseline           # overwrite the baseline with this run
 *
 * Two scorers exist: `contains` (substring match — cheap, loose, the default)
 * and `llm` (asks an LLM whether the retrieved snippets answer the question
 * — needs OPENAI_API_KEY, costs tokens, but tolerates paraphrase). `both` runs
 * the LLM grader and additionally reports the contains rate as a sanity check.
 *
 * The runner needs a real embedder to be meaningful. With OPENAI_API_KEY
 * unset it falls back to the stub and the numbers are noise — the harness
 * still runs so plumbing changes are caught early.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getSettings } from "../src/config.js";
import { OpenAILLMClient } from "../src/llm/openai-llm-client.js";
import { getLogger } from "../src/logging.js";
import { MemCore } from "../src/memcore.js";
import {
  type Baseline,
  compareToBaseline,
  loadBaseline,
  reportToBaseline,
  writeBaseline,
} from "./baseline.js";
import { LLMGrader } from "./grader.js";
import { type Report, aggregate } from "./metrics.js";
import type { EvalCase, EvalResult } from "./types.js";

const logger = getLogger("evals.runner");

type GraderMode = "contains" | "llm" | "both";

interface RunnerArgs {
  category: string | null;
  outputPath: string | null;
  grader: GraderMode;
  baseline: boolean;
  updateBaseline: boolean;
  baselinePath: string;
  tolerance: number;
}

function parseArgs(argv: string[]): RunnerArgs {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const args: RunnerArgs = {
    category: null,
    outputPath: null,
    grader: "contains",
    baseline: false,
    updateBaseline: false,
    baselinePath: resolve(here, "baseline.json"),
    tolerance: 0.05,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--category") args.category = argv[++i] ?? null;
    else if (a === "--output") args.outputPath = argv[++i] ?? null;
    else if (a === "--grader") {
      const v = argv[++i];
      if (v !== "contains" && v !== "llm" && v !== "both") {
        throw new Error(`--grader must be one of contains|llm|both, got ${v}`);
      }
      args.grader = v;
    } else if (a === "--baseline") args.baseline = true;
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--baseline-path") args.baselinePath = resolve(argv[++i] ?? "");
    else if (a === "--tolerance") args.tolerance = Number(argv[++i] ?? "0.05");
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

function scoreContains(
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

interface RunCaseDeps {
  memcore: MemCore;
  containerTag: string;
  grader: GraderMode;
  llmGrader: LLMGrader | null;
}

async function runCase(deps: RunCaseDeps, c: EvalCase): Promise<EvalResult> {
  const start = performance.now();
  const result = await deps.memcore.search({
    containerTag: deps.containerTag,
    query: c.question,
    limit: 5,
    includeChunks: true,
  });
  const latencyMs = Math.round(performance.now() - start);
  // Score the memory content first; fall back to source chunks so the metric
  // still works even when extraction returned [] for the relevant material.
  const retrievedContents = result.results.flatMap((r) => [
    r.memory.content,
    ...r.memory.chunks.map((ch) => ch.content),
  ]);
  const shouldAbstain = result.queryMetadata.shouldAbstain;

  const containsPassed = scoreContains(c, retrievedContents, shouldAbstain, result.results.length);

  let passed = containsPassed;
  let notes: string | undefined;
  if (deps.grader !== "contains" && deps.llmGrader) {
    const verdict = await deps.llmGrader.grade({
      case: c,
      retrievedContents,
      shouldAbstain,
      resultsCount: result.results.length,
    });
    passed = verdict.passed;
    notes =
      deps.grader === "both"
        ? `llm:${verdict.passed} contains:${containsPassed} — ${verdict.rationale}`
        : verdict.rationale;
  }

  return {
    case_id: c.case_id,
    category: c.category,
    passed,
    retrievedTopK: result.results.map((r) => ({ content: r.memory.content, score: r.score })),
    latencyMs,
    shouldAbstain,
    notes,
  };
}

function printReport(report: Report, baseline: Baseline | null): void {
  console.log("\n=== Eval report ===");
  console.log(
    `Overall: ${report.overall.passed}/${report.overall.total} (${(
      report.overall.accuracy * 100
    ).toFixed(1)}%)`,
  );
  for (const c of report.byCategory) {
    const baseEntry = baseline?.byCategory.find((b) => b.category === c.category);
    const delta = baseEntry ? ` (Δ ${formatDelta(c.accuracy - baseEntry.accuracy)})` : "";
    console.log(
      `  ${c.category}: ${c.passed}/${c.total} (${(c.accuracy * 100).toFixed(1)}%)${delta} ` +
        `p50=${c.p50LatencyMs}ms p95=${c.p95LatencyMs}ms`,
    );
  }
}

function formatDelta(d: number): string {
  const pct = (d * 100).toFixed(1);
  if (d > 0) return `+${pct}pp`;
  return `${pct}pp`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const settings = getSettings();
  const cases = loadCases(args.category);
  if (cases.length === 0) {
    logger.warn({ category: args.category }, "no eval cases found");
    return;
  }
  logger.info(
    { count: cases.length, category: args.category, grader: args.grader },
    "running eval cases",
  );

  let llmGrader: LLMGrader | null = null;
  if (args.grader !== "contains") {
    if (!settings.openaiApiKey) {
      throw new Error("--grader llm|both requires OPENAI_API_KEY to be set");
    }
    const graderClient = new OpenAILLMClient({
      apiKey: settings.openaiApiKey,
      defaultModel: settings.extractionModel,
      ...(settings.llmBaseUrl ? { baseUrl: settings.llmBaseUrl } : {}),
    });
    llmGrader = new LLMGrader({ client: graderClient, model: settings.extractionModel });
  }

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
    ...(settings.llmBaseUrl ? { llmBaseUrl: settings.llmBaseUrl } : {}),
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
      const result = await runCase({ memcore, containerTag, grader: args.grader, llmGrader }, c);
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
  const existingBaseline = loadBaseline(args.baselinePath);
  printReport(report, existingBaseline);
  if (args.outputPath) {
    writeFileSync(args.outputPath, JSON.stringify({ report, results }, null, 2), "utf8");
    logger.info({ path: args.outputPath }, "report_written");
  }

  if (args.updateBaseline) {
    const next = reportToBaseline(report, {
      grader: args.grader,
      embeddingModel: settings.embeddingModel,
      extractionModel: settings.extractionModel,
    });
    writeBaseline(args.baselinePath, next);
    logger.info({ path: args.baselinePath }, "baseline_written");
    return;
  }

  if (args.baseline) {
    if (!existingBaseline) {
      logger.error(
        { path: args.baselinePath },
        "baseline file not found; run with --update-baseline to capture",
      );
      process.exit(2);
    }
    const regression = compareToBaseline(existingBaseline, report, args.tolerance);
    if (!regression.ok) {
      console.log("\n=== Regression vs baseline ===");
      for (const f of regression.failures) {
        console.log(
          `  ${f.category}: ${(f.baseline * 100).toFixed(1)}% → ${(f.current * 100).toFixed(
            1,
          )}% (${formatDelta(f.delta)})`,
        );
      }
      process.exit(1);
    }
    logger.info({ tolerance: args.tolerance }, "baseline_check_passed");
  }
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "eval_runner_failed");
  process.exit(1);
});
