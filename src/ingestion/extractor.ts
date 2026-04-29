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
import { EXTRACTION_PROMPT_VERSION, loadPrompt } from "../prompts/loader.js";

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

const ExtractedMemorySchema = z.object({
  content: z.string().min(1),
  category: z.enum(MEMORY_CATEGORIES),
  confidence: z.number().min(0).max(1),
});

const ExtractionResponseSchema = z.array(ExtractedMemorySchema);

export type ExtractedMemory = z.infer<typeof ExtractedMemorySchema>;

export interface ExtractArgs {
  chunkContent: string;
  /** The session/document text the chunk was drawn from, when available, for context. */
  sourceContext?: string;
}

export interface ExtractDeps {
  llm: LLMClient;
  model: string;
  maxTokens?: number;
}

const SYSTEM_TEMPLATE = loadPrompt("extraction_v1");

export async function extractMemories(
  deps: ExtractDeps,
  args: ExtractArgs,
): Promise<ExtractedMemory[]> {
  const userMessage = `<chunk>\n${args.chunkContent}\n</chunk>`;

  const response = await deps.llm.createMessage({
    model: deps.model,
    system: SYSTEM_TEMPLATE,
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

  return result.data;
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
