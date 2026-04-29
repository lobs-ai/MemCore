/**
 * Temporal query parser.
 *
 * Phase 5: an LLM call at the head of the search pipeline that decides whether
 * the query implies a date window, and if so, which axis (`event_date` vs
 * `document_date`) and the bounds. Most queries return null — there is no
 * temporal scope — and the search proceeds without a date filter.
 *
 * Failure-safe: any error or malformed response returns null. We'd rather skip
 * a temporal narrowing than refuse to search.
 *
 * Two-axis time is the SPEC § temporal model:
 *   - event_date: when the described thing happened or will happen.
 *   - document_date: when the source was authored.
 *
 * The parser is allowed (and expected) to leave one bound open ("from" only,
 * for "since 2024", or "to" only, for "before March"). The temporal-filter
 * helper handles open bounds.
 */
import { z } from "zod";

import type { LLMClient } from "../llm/client.js";
import { responseText } from "../llm/types.js";
import { getLogger } from "../logging.js";
import { TEMPORAL_PARSER_PROMPT_VERSION, format, loadPrompt } from "../prompts/loader.js";

const logger = getLogger("retrieval.temporal-parser");

const SYSTEM_TEMPLATE = loadPrompt("temporal_parser_v1");

const AXES = ["event_date", "document_date"] as const;
export type DateAxis = (typeof AXES)[number];

export interface DateRange {
  axis: DateAxis;
  from: Date | null;
  to: Date | null;
}

const RawSchema = z
  .object({
    axis: z.enum(AXES),
    from: z.union([z.string(), z.null()]).optional(),
    to: z.union([z.string(), z.null()]).optional(),
  })
  .nullable();

export interface ParseTemporalArgs {
  query: string;
  /** Anchor used to resolve relative phrases. Defaults to "now". */
  now?: Date;
}

export interface ParseTemporalDeps {
  llm: LLMClient;
  model: string;
  maxTokens?: number;
}

export async function parseTemporalScope(
  deps: ParseTemporalDeps,
  args: ParseTemporalArgs,
): Promise<DateRange | null> {
  const now = args.now ?? new Date();
  const system = format(SYSTEM_TEMPLATE, { today_date: isoDay(now) });

  let raw: string;
  try {
    const response = await deps.llm.createMessage({
      model: deps.model,
      system,
      messages: [{ role: "user", content: `<query>\n${args.query}\n</query>` }],
      maxTokens: deps.maxTokens ?? 128,
      temperature: 0,
    });
    raw = responseText(response).trim();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "temporal_parser_failed_skipping",
    );
    return null;
  }

  return parseResponse(raw);
}

export function parseResponse(raw: string): DateRange | null {
  if (!raw) return null;
  let text = raw;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();

  // The model may return the literal `null`. Handle that fast-path before
  // hunting for braces.
  if (text === "null") return null;

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    // No object and not an explicit null — treat as "no temporal scope" rather
    // than throw. Search must proceed.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
  const result = RawSchema.safeParse(parsed);
  if (!result.success || result.data === null) return null;

  const from = parseDate(result.data.from ?? null);
  const to = parseDate(result.data.to ?? null);
  if (from === null && to === null) return null;
  return { axis: result.data.axis, from, to };
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const text = value.length === 10 ? `${value}T00:00:00Z` : value;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export { TEMPORAL_PARSER_PROMPT_VERSION };
