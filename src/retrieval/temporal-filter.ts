/**
 * Temporal filter for memory candidates.
 *
 * Phase 5: applied between RRF and rerank. Given a date range from the
 * `/v1/search` request body or the temporal-parser, this drops candidate
 * memory ids whose `document_date` or `event_date` falls outside the window.
 *
 * Behavioural notes:
 *   - Open bounds are honoured. `from` only = "since X". `to` only = "before X".
 *   - Memories with a NULL value on the filtered axis are dropped, with one
 *     exception: when the axis is `event_date` and a memory's event_date is
 *     null, that memory is "timeless" (preference, identity fact) and we
 *     keep it. Filtering it out would hide stable facts whose answer doesn't
 *     depend on the asked window. document_date is never null in practice
 *     (the pipeline always populates it from the conversation), so we drop
 *     null document_date rows defensively.
 */
import type postgres from "postgres";

import type { DateRange } from "./temporal-parser.js";

export interface FilterTemporalArgs {
  containerId: string;
  candidateIds: string[];
  range: DateRange;
}

export async function filterByDateRange(
  sql: postgres.Sql,
  args: FilterTemporalArgs,
): Promise<string[]> {
  if (args.candidateIds.length === 0) return [];
  const { range, candidateIds, containerId } = args;
  const from = range.from ?? null;
  const to = range.to ?? null;
  if (from === null && to === null) return candidateIds;

  // Inclusive bounds. Postgres handles TIMESTAMPTZ vs DATE coercion via the
  // bound parameters being JS Dates (postgres.js encodes them as TIMESTAMPTZ).
  if (range.axis === "event_date") {
    const rows = await sql<{ id: string }[]>`
      SELECT id
      FROM memories
      WHERE container_id = ${containerId}
        AND id IN ${sql(candidateIds)}
        AND (
          event_date IS NULL
          OR (
            (${from}::timestamptz IS NULL OR event_date >= ${from}::timestamptz)
            AND (${to}::timestamptz IS NULL OR event_date <= ${to}::timestamptz)
          )
        )
    `;
    return preserveOrder(
      candidateIds,
      rows.map((r) => r.id),
    );
  }

  const rows = await sql<{ id: string }[]>`
    SELECT id
    FROM memories
    WHERE container_id = ${containerId}
      AND id IN ${sql(candidateIds)}
      AND document_date IS NOT NULL
      AND (${from}::timestamptz IS NULL OR document_date >= ${from}::timestamptz)
      AND (${to}::timestamptz IS NULL OR document_date <= ${to}::timestamptz)
  `;
  return preserveOrder(
    candidateIds,
    rows.map((r) => r.id),
  );
}

function preserveOrder(input: string[], allowed: string[]): string[] {
  const set = new Set(allowed);
  return input.filter((id) => set.has(id));
}
