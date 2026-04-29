/**
 * Conflict detector.
 *
 * For each newly extracted memory, we want to know how it relates to memories
 * the user already has on file. The detector runs a vector similarity search
 * against the existing `memories` table (within the same `container_id`),
 * passes the top-K candidates plus the new memory to an LLM, and parses the
 * response into a `ConflictDecision`.
 *
 * Decisions:
 *   - new          → first time we have heard this; no edge.
 *   - duplicate    → same fact, different wording; skip the insert and link
 *                    the source chunk to the existing memory instead.
 *   - update       → user changed state; existing memory's status becomes
 *                    `superseded` and an `updates` edge is written.
 *   - extend       → refinement; both memories stay active, `extends` edge.
 *   - derive       → second-order conclusion; `derives` edge.
 *   - contradicts  → unresolved conflict; both stay active, `contradicts` edge.
 *
 * Cost note: when no top-K candidate clears `similarityThreshold` (default
 * 0.75 cosine similarity) we treat the candidate as `new` without an LLM
 * call. This keeps the common case (most memories are not collisions) cheap.
 */

import type postgres from "postgres";
import { z } from "zod";

import { vectorLiteral } from "../db/vector.js";
import type { LLMClient } from "../llm/client.js";
import { responseText } from "../llm/types.js";
import { getLogger } from "../logging.js";
import { CONFLICT_DETECTOR_PROMPT_VERSION, loadPrompt } from "../prompts/loader.js";

const logger = getLogger("ingestion.conflict-detector");

const RELATIONSHIP_TYPES = ["updates", "extends", "derives", "contradicts"] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

const DECISIONS = ["new", "duplicate", "update", "extend", "derive", "contradicts"] as const;
export type Decision = (typeof DECISIONS)[number];

const DEFAULT_TOP_K = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

const SYSTEM_TEMPLATE = loadPrompt("conflict_detector_v1");

const ConflictResponseSchema = z.object({
  decision: z.enum(DECISIONS),
  target_id: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

export interface CandidateMemory {
  /** Stable index used to map decisions back to the caller's array. */
  index: number;
  content: string;
  category: string;
  vector: number[];
}

export interface ExistingMemory {
  id: string;
  content: string;
  category: string;
  documentDate: Date | null;
  similarity: number;
}

export interface ConflictDecision {
  index: number;
  decision: Decision;
  /** Existing memory id when the decision implies one; otherwise null. */
  targetId: string | null;
  confidence: number;
  reason?: string;
  /** Existing memories considered for this candidate. Useful for tracing. */
  candidates: ExistingMemory[];
}

export interface DetectConflictsArgs {
  containerId: string;
  candidates: CandidateMemory[];
}

export type SimilarMemoryFinder = (args: {
  containerId: string;
  vector: number[];
  limit: number;
}) => Promise<ExistingMemory[]>;

export interface DetectConflictsDeps {
  llm: LLMClient;
  model: string;
  /**
   * Looks up the top-K most similar existing memories within a container.
   * The default implementation `pgSimilarMemoryFinder(sql)` runs a cosine
   * vector search against the `memories` table; tests can swap in a stub.
   */
  findSimilar: SimilarMemoryFinder;
  topK?: number;
  /**
   * Cosine similarity (0..1, higher = more similar) below which we skip the
   * LLM call entirely and classify the candidate as `new`. Default 0.75.
   */
  similarityThreshold?: number;
  maxTokens?: number;
}

export async function detectConflicts(
  deps: DetectConflictsDeps,
  args: DetectConflictsArgs,
): Promise<ConflictDecision[]> {
  const topK = deps.topK ?? DEFAULT_TOP_K;
  const threshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const out: ConflictDecision[] = [];

  for (const candidate of args.candidates) {
    const existing = await deps.findSimilar({
      containerId: args.containerId,
      vector: candidate.vector,
      limit: topK,
    });
    const passingThreshold = existing.filter((e) => e.similarity >= threshold);

    if (passingThreshold.length === 0) {
      out.push({
        index: candidate.index,
        decision: "new",
        targetId: null,
        confidence: 1.0,
        candidates: existing,
      });
      continue;
    }

    try {
      const decision = await classify(deps, candidate, passingThreshold);
      out.push({ ...decision, index: candidate.index, candidates: existing });
    } catch (err) {
      // A detector failure must not block ingestion. The safe fallback is
      // `new`: we keep the memory as-is, accepting a possible duplicate over
      // a missed insert.
      logger.warn(
        { err: err instanceof Error ? err.message : err, candidateIndex: candidate.index },
        "conflict_detector_failed_treating_as_new",
      );
      out.push({
        index: candidate.index,
        decision: "new",
        targetId: null,
        confidence: 0.5,
        candidates: existing,
      });
    }
  }

  return out;
}

/**
 * Default `findSimilar` backed by Postgres + pgvector. Pulls the top-K most
 * similar active memories within the container by cosine distance.
 */
export function pgSimilarMemoryFinder(sql: postgres.Sql): SimilarMemoryFinder {
  return async ({ containerId, vector, limit }) => {
    const literal = vectorLiteral(vector);
    const rows = await sql<
      {
        id: string;
        content: string;
        category: string;
        document_date: Date | null;
        distance: number;
      }[]
    >`
      SELECT
        id, content, category, document_date,
        embedding <=> ${literal}::vector AS distance
      FROM memories
      WHERE container_id = ${containerId}
        AND status = 'active'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      documentDate: row.document_date,
      similarity: Math.max(0, 1 - Number(row.distance)),
    }));
  };
}

function renderExisting(existing: ExistingMemory[]): string {
  return existing
    .map((m) => {
      const date = m.documentDate ? m.documentDate.toISOString() : "null";
      return `id=${m.id} | category=${m.category} | document_date=${date} | content=${m.content}`;
    })
    .join("\n");
}

async function classify(
  deps: DetectConflictsDeps,
  candidate: CandidateMemory,
  existing: ExistingMemory[],
): Promise<Omit<ConflictDecision, "index" | "candidates">> {
  const userMessage =
    `<candidate>\ncategory=${candidate.category}\ncontent=${candidate.content}\n</candidate>\n` +
    `<existing>\n${renderExisting(existing)}\n</existing>`;

  const response = await deps.llm.createMessage({
    model: deps.model,
    system: SYSTEM_TEMPLATE,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: deps.maxTokens ?? 256,
    temperature: 0,
  });

  const raw = responseText(response).trim();
  const parsed = parseJsonObject(raw);
  const result = ConflictResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`conflict detector returned invalid JSON: ${result.error.message}`);
  }

  const validIds = new Set(existing.map((e) => e.id));
  const targetIdRaw = result.data.target_id;
  const targetId = targetIdRaw && validIds.has(targetIdRaw) ? targetIdRaw : null;

  // Fall back to `new` if a non-`new` decision didn't reference a valid id —
  // we'd rather store a duplicate than write a dangling edge.
  if (result.data.decision !== "new" && targetId === null) {
    return {
      decision: "new",
      targetId: null,
      confidence: result.data.confidence,
      reason: "decision required a target_id but none of the existing ids matched",
    };
  }

  const out: Omit<ConflictDecision, "index" | "candidates"> = {
    decision: result.data.decision,
    targetId,
    confidence: result.data.confidence,
  };
  if (result.data.reason) out.reason = result.data.reason;
  return out;
}

function parseJsonObject(raw: string): unknown {
  let text = raw;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error(`no JSON object found in response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(first, last + 1));
}

/**
 * Map a decision to the edge type written to the `edges` table. Returns null
 * for `new` and `duplicate` (no edge is written for those).
 */
export function decisionToRelationship(decision: Decision): RelationshipType | null {
  switch (decision) {
    case "update":
      return "updates";
    case "extend":
      return "extends";
    case "derive":
      return "derives";
    case "contradicts":
      return "contradicts";
    default:
      return null;
  }
}

export { CONFLICT_DETECTOR_PROMPT_VERSION };
