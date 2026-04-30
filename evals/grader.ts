/**
 * LLM grader for eval cases.
 *
 * `contains` (the default scorer) checks whether the expected answer string
 * appears verbatim in the retrieved content. That misses paraphrases ("Paris"
 * vs "the city of Paris, France") and is loose in the other direction too —
 * an unrelated chunk that happens to contain the token "paris" passes.
 *
 * The grader asks an LLM to make the call: given the question, the expected
 * answer, and the retrieved memory contents, did retrieval surface enough
 * information to answer the question correctly? We force a strict JSON shape
 * so the runner can parse without heuristics.
 *
 * Abstain cases use a separate path: the model is asked whether the retrieved
 * content would mislead the agent into answering when it shouldn't.
 */

import type { LLMClient } from "../src/llm/client.js";
import { responseText } from "../src/llm/types.js";
import type { EvalCase } from "./types.js";

export interface GraderVerdict {
  passed: boolean;
  rationale: string;
}

export interface GraderInput {
  case: EvalCase;
  retrievedContents: string[];
  shouldAbstain: boolean;
  resultsCount: number;
}

const SYSTEM_PROMPT = `You are grading a retrieval system for a memory engine.
You will be given a user question, an expected answer, and the memory snippets
the retrieval system returned. Decide whether the retrieved snippets actually
contain the information needed to answer the question.

Rules:
- A paraphrase counts. "Paris" and "the city of Paris" both answer "what is the capital of France".
- Partial-but-sufficient counts. The snippet does not need to *be* the answer string — it needs to support the answer.
- A snippet that mentions the topic but not the answer does NOT count. ("Paris is in Europe" does not answer "what is the capital of France".)
- Stale or contradicted information does NOT count. If the question asks for the user's *current* state and the snippets only show a prior, superseded fact, mark fail.

Reply with strict JSON: {"passed": true|false, "rationale": "<one sentence>"}.
No prose outside the JSON.`;

const ABSTAIN_SYSTEM_PROMPT = `You are grading a retrieval system on an "abstain" case:
the correct behavior is to NOT surface a confident answer, because the answer
isn't in memory. You will see the user question and the memory snippets the
retrieval system returned.

A pass means: the snippets are empty, off-topic, or weak enough that an agent
using them would correctly say "I don't know" rather than fabricate. A fail
means: a snippet looks like it answers the question, which would mislead the
agent into hallucinating.

Reply with strict JSON: {"passed": true|false, "rationale": "<one sentence>"}.
No prose outside the JSON.`;

export interface LLMGraderOptions {
  client: LLMClient;
  model: string;
  /** Cap on snippet count fed to the grader; long inputs are cropped. */
  maxSnippets?: number;
  /** Cap on chars per snippet; long snippets are truncated mid-string. */
  maxSnippetChars?: number;
}

export class LLMGrader {
  private readonly client: LLMClient;
  private readonly model: string;
  private readonly maxSnippets: number;
  private readonly maxSnippetChars: number;

  constructor(opts: LLMGraderOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.maxSnippets = opts.maxSnippets ?? 10;
    this.maxSnippetChars = opts.maxSnippetChars ?? 800;
  }

  async grade(input: GraderInput): Promise<GraderVerdict> {
    const isAbstain = input.case.scoring === "abstain" || input.case.category === "abstain";

    // Short-circuit: empty retrieval on an abstain case is an unambiguous pass.
    // No reason to spend tokens.
    if (isAbstain && input.resultsCount === 0) {
      return { passed: true, rationale: "no results returned for abstain case" };
    }

    const snippets = input.retrievedContents
      .slice(0, this.maxSnippets)
      .map((s, i) => `[${i + 1}] ${truncate(s, this.maxSnippetChars)}`)
      .join("\n");

    const userPrompt = isAbstain
      ? buildAbstainUserPrompt(input.case.question, snippets || "<no snippets>")
      : buildUserPrompt(
          input.case.question,
          input.case.expected_answer,
          snippets || "<no snippets>",
        );

    const response = await this.client.createMessage({
      model: this.model,
      system: isAbstain ? ABSTAIN_SYSTEM_PROMPT : SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 200,
      temperature: 0,
    });

    return parseVerdict(responseText(response));
  }
}

function buildUserPrompt(question: string, expected: string, snippets: string): string {
  return [
    `Question: ${question}`,
    `Expected answer: ${expected}`,
    "",
    "Retrieved snippets:",
    snippets,
  ].join("\n");
}

function buildAbstainUserPrompt(question: string, snippets: string): string {
  return [`Question: ${question}`, "", "Retrieved snippets:", snippets].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export function parseVerdict(raw: string): GraderVerdict {
  // The model is told to return strict JSON, but real models occasionally
  // wrap it in a code fence or add a "Sure!" prefix. Pull out the first {...}
  // block and parse that. If parsing fails entirely, mark fail with the raw
  // text as rationale — better visible than silent.
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { passed: false, rationale: `grader returned non-JSON: ${trimmed.slice(0, 200)}` };
  }
  const slice = trimmed.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as { passed?: unknown; rationale?: unknown };
    return {
      passed: parsed.passed === true,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch (err) {
    return {
      passed: false,
      rationale: `grader JSON parse failed: ${(err as Error).message}; raw=${slice.slice(0, 200)}`,
    };
  }
}
