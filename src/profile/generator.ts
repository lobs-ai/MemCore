/**
 * Profile generator (Phase 6).
 *
 * Pulls every active memory in a container, hands them to the LLM with the
 * profile prompt, and upserts a single `profiles` row. The profile is a stable
 * narrative summary of the user's durable traits — identity, preferences,
 * constraints, relationships, goals, open events — that the search path can
 * inject when a query is profile-relevant ("what do you know about me?").
 *
 * Generation is deterministic for a given memory set (temperature 0). Calling
 * `generateProfile` twice in a row without new memories produces the same text
 * (modulo provider non-determinism); the row's `version` still increments to
 * record the rebuild.
 *
 * The generator is intentionally a one-shot synchronous-from-the-caller's-side
 * operation. The "background job" framing in ROADMAP § Phase 6 is satisfied by
 * scheduling `MemCore.buildProfile()` from the queue or a cron — the generator
 * itself doesn't own the schedule.
 */
import type postgres from "postgres";

import type { LLMClient } from "../llm/client.js";
import { responseText } from "../llm/types.js";
import { getLogger } from "../logging.js";
import { PROFILE_GENERATOR_PROMPT_VERSION, format, loadPrompt } from "../prompts/loader.js";

const logger = getLogger("profile.generator");

const SYSTEM_TEMPLATE = loadPrompt("profile_generator_v1");

export interface ProfileMemoryRow {
  id: string;
  content: string;
  category: string;
  status: string;
  confidence: number;
  eventDate: Date | null;
}

export interface ProfileRecord {
  id: string;
  containerId: string;
  content: string;
  sourceMemoryIds: string[];
  sourceMemoryCount: number;
  version: number;
  promptVersion: string;
  generatorModel: string;
  generatedAt: Date;
}

export interface BuildProfileArgs {
  containerId: string;
  /** ISO day used to anchor "open events" classification. Defaults to "today". */
  now?: Date;
}

export interface BuildProfileDeps {
  llm: LLMClient;
  model: string;
  /** Cap on the number of active memories fed into the prompt. Default 200. */
  maxMemories?: number;
  maxTokens?: number;
}

const DEFAULT_MAX_MEMORIES = 200;

export async function generateProfile(
  sql: postgres.Sql,
  deps: BuildProfileDeps,
  args: BuildProfileArgs,
): Promise<ProfileRecord | null> {
  const limit = deps.maxMemories ?? DEFAULT_MAX_MEMORIES;
  const memories = await fetchActiveMemories(sql, args.containerId, limit);
  if (memories.length === 0) {
    logger.info({ containerId: args.containerId }, "profile_generation_skipped_no_active_memories");
    return null;
  }

  const now = args.now ?? new Date();
  const system = format(SYSTEM_TEMPLATE, { today_date: isoDay(now) });
  const userMessage = `<memories>\n${renderMemories(memories)}\n</memories>`;

  const response = await deps.llm.createMessage({
    model: deps.model,
    system,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: deps.maxTokens ?? 1024,
    temperature: 0,
  });
  const content = responseText(response).trim();
  if (!content) {
    logger.warn({ containerId: args.containerId }, "profile_generator_empty_response");
    return null;
  }

  return upsertProfile(sql, {
    containerId: args.containerId,
    content,
    sourceMemoryIds: memories.map((m) => m.id),
    promptVersion: PROFILE_GENERATOR_PROMPT_VERSION,
    generatorModel: deps.model,
  });
}

export async function fetchActiveMemories(
  sql: postgres.Sql,
  containerId: string,
  limit: number,
): Promise<ProfileMemoryRow[]> {
  const rows = await sql<
    {
      id: string;
      content: string;
      category: string;
      status: string;
      confidence: number;
      event_date: Date | null;
    }[]
  >`
    SELECT id, content, category, status, confidence, event_date
    FROM memories
    WHERE container_id = ${containerId} AND status = 'active'
    ORDER BY
      CASE category
        WHEN 'fact' THEN 0
        WHEN 'constraint' THEN 1
        WHEN 'relationship' THEN 2
        WHEN 'preference' THEN 3
        WHEN 'goal' THEN 4
        WHEN 'event' THEN 5
        WHEN 'opinion' THEN 6
        ELSE 7
      END,
      created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    category: r.category,
    status: r.status,
    confidence: Number(r.confidence),
    eventDate: r.event_date,
  }));
}

interface UpsertArgs {
  containerId: string;
  content: string;
  sourceMemoryIds: string[];
  promptVersion: string;
  generatorModel: string;
}

async function upsertProfile(sql: postgres.Sql, args: UpsertArgs): Promise<ProfileRecord> {
  const rows = await sql<
    {
      id: string;
      container_id: string;
      content: string;
      source_memory_ids: string[];
      source_memory_count: number;
      version: number;
      prompt_version: string;
      generator_model: string;
      generated_at: Date;
    }[]
  >`
    INSERT INTO profiles (
      container_id, content, source_memory_ids, source_memory_count,
      version, prompt_version, generator_model, generated_at
    )
    VALUES (
      ${args.containerId}, ${args.content}, ${args.sourceMemoryIds}::uuid[],
      ${args.sourceMemoryIds.length}, 1, ${args.promptVersion},
      ${args.generatorModel}, NOW()
    )
    ON CONFLICT (container_id) DO UPDATE SET
      content = EXCLUDED.content,
      source_memory_ids = EXCLUDED.source_memory_ids,
      source_memory_count = EXCLUDED.source_memory_count,
      version = profiles.version + 1,
      prompt_version = EXCLUDED.prompt_version,
      generator_model = EXCLUDED.generator_model,
      generated_at = NOW()
    RETURNING
      id, container_id, content, source_memory_ids, source_memory_count,
      version, prompt_version, generator_model, generated_at
  `;
  const row = rows[0];
  if (!row) throw new Error("profile upsert returned no row");
  return {
    id: row.id,
    containerId: row.container_id,
    content: row.content,
    sourceMemoryIds: row.source_memory_ids,
    sourceMemoryCount: row.source_memory_count,
    version: row.version,
    promptVersion: row.prompt_version,
    generatorModel: row.generator_model,
    generatedAt: row.generated_at,
  };
}

export async function getProfileByContainer(
  sql: postgres.Sql,
  containerId: string,
): Promise<ProfileRecord | null> {
  const rows = await sql<
    {
      id: string;
      container_id: string;
      content: string;
      source_memory_ids: string[];
      source_memory_count: number;
      version: number;
      prompt_version: string;
      generator_model: string;
      generated_at: Date;
    }[]
  >`
    SELECT id, container_id, content, source_memory_ids, source_memory_count,
           version, prompt_version, generator_model, generated_at
    FROM profiles
    WHERE container_id = ${containerId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    containerId: row.container_id,
    content: row.content,
    sourceMemoryIds: row.source_memory_ids,
    sourceMemoryCount: row.source_memory_count,
    version: row.version,
    promptVersion: row.prompt_version,
    generatorModel: row.generator_model,
    generatedAt: row.generated_at,
  };
}

export function renderMemories(memories: ProfileMemoryRow[]): string {
  return memories
    .map((m) => {
      const ed = m.eventDate ? m.eventDate.toISOString().slice(0, 10) : "null";
      return `${m.category} | ${ed} | ${m.confidence.toFixed(2)} | ${m.content}`;
    })
    .join("\n");
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export { PROFILE_GENERATOR_PROMPT_VERSION };
