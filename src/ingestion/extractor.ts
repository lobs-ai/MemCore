/**
 * Memory extractor.
 *
 * Calls the configured `LLMClient` with the extraction prompt and parses the
 * JSON array response into typed `ExtractedMemory[]`. Most chunks return [];
 * that's expected, not a bug (see DESIGN.md and AGENTS.md).
 *
 * The prompt is versioned via `EXTRACTION_PROMPT_VERSION` so we can identify
 * which memories were produced by which prompt and re-extract when prompts
 * change. Bumping the prompt = new file (`extraction_v2.txt`) + bump the
 * constant. Don't edit `extraction_v1.txt` in place.
 */

import { z } from "zod";
import { ExtractionError } from "../errors.js";
import type { LLMClient } from "../llm/client.js";
import { responseText } from "../llm/types.js";
import { getLogger } from "../logging.js";
import { EXTRACTION_PROMPT_VERSION, format, loadPrompt } from "../prompts/loader.js";

const logger = getLogger("ingestion.extractor");

const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "goal",
  "event",
  "relationship",
  "constraint",
  "opinion",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const EVENT_DATE_PRECISIONS = ["day", "month", "year", "unknown"] as const;
export type EventDatePrecision = (typeof EVENT_DATE_PRECISIONS)[number];

// Accept either YYYY-MM-DD or a full ISO datetime; coerce to a Date.
const EventDateField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v == null || v === "") return null;
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? null : d;
  });

const ExtractedMemorySchema = z.object({
  content: z.string().min(1),
  category: z.enum(MEMORY_CATEGORIES),
  confidence: z.number().min(0).max(1),
  event_date: EventDateField,
  event_date_precision: z.enum(EVENT_DATE_PRECISIONS).optional().default("unknown"),
});

const ExtractionResponseSchema = z.array(ExtractedMemorySchema);

type RawExtractedMemory = z.infer<typeof ExtractedMemorySchema>;

export interface ExtractedMemory {
  content: string;
  category: MemoryCategory;
  confidence: number;
  /** When the described event actually happened, resolved against documentDate. Null for timeless facts. */
  eventDate: Date | null;
  eventDatePrecision: EventDatePrecision;
}

export interface ExtractArgs {
  chunkContent: string;
  /** The session/document text the chunk was drawn from, when available, for context. */
  sourceContext?: string;
  /**
   * Date the chunk was authored. The extractor uses this to resolve relative
   * temporal phrases ("yesterday", "last spring") into absolute event_date
   * values. Defaults to "today" (UTC) when omitted.
   */
  documentDate?: Date;
}

export interface ExtractDeps {
  llm: LLMClient;
  model: string;
  maxTokens?: number;
}

const SYSTEM_TEMPLATE = loadPrompt("extraction_v2");

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function extractMemories(
  deps: ExtractDeps,
  args: ExtractArgs,
): Promise<ExtractedMemory[]> {
  const userMessage = `<chunk>\n${args.chunkContent}\n</chunk>`;
  const documentDate = args.documentDate ?? new Date();
  const system = format(SYSTEM_TEMPLATE, { document_date: isoDay(documentDate) });

  const response = await deps.llm.createMessage({
    model: deps.model,
    system,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: deps.maxTokens ?? 1024,
    temperature: 0,
  });

  const raw = responseText(response).trim();
  if (!raw) return [];

  const parsed = parseJsonArray(raw);
  const result = ExtractionResponseSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { issues: result.error.issues, raw: raw.slice(0, 500) },
      "extractor_invalid_response",
    );
    throw new ExtractionError("extractor returned invalid JSON shape", {
      issues: result.error.issues,
    });
  }

  return result.data.map(toExtractedMemory);
}

function toExtractedMemory(raw: RawExtractedMemory): ExtractedMemory {
  // If event_date is null, force precision to "unknown" — the model
  // occasionally emits "day" with a null date and that's nonsense.
  const eventDate = raw.event_date;
  const eventDatePrecision: EventDatePrecision = eventDate ? raw.event_date_precision : "unknown";
  return {
    content: raw.content,
    category: raw.category,
    confidence: raw.confidence,
    eventDate,
    eventDatePrecision,
  };
}

/**
 * Models occasionally wrap JSON in ```json fences or add a stray prose line.
 * Strip fences and trim to the first balanced top-level array. If we can't
 * find one, throw — better to fail the chunk than silently lose memories.
 */
function parseJsonArray(raw: string): unknown {
  let text = raw;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new ExtractionError("extractor response did not contain a JSON array", {
      preview: raw.slice(0, 200),
    });
  }
  const slice = text.slice(firstBracket, lastBracket + 1);
  try {
    return JSON.parse(slice);
  } catch (err) {
    throw new ExtractionError("extractor JSON parse failed", {
      message: (err as Error).message,
      preview: slice.slice(0, 200),
    });
  }
}

export { EXTRACTION_PROMPT_VERSION };
