/**
 * Session boundary scanner.
 *
 * Per SPEC § Session boundary detection: every N minutes, find conversations
 * that look "done" (ended_at set, or last_message_at older than the
 * inactivity window, or message_count past the length cap) and enqueue them
 * for ingestion.
 *
 * Phase 2 ships the scanner. The /v1/add path enqueues immediately, so most
 * sessions go through "ingest" jobs and never need this. The scanner exists
 * for cases where conversations are appended to via direct DB writes (a
 * connector adding messages, for instance).
 */

import type postgres from "postgres";
import { getLogger } from "../logging.js";
import type { IngestionProducer } from "./producer.js";

const logger = getLogger("queue.session-boundary");

export interface BoundaryConfig {
  inactivityMinutes: number;
  lengthThreshold: number;
}

export async function scanForBoundaries(
  sql: postgres.Sql,
  producer: IngestionProducer,
  config: BoundaryConfig,
): Promise<{ enqueued: number }> {
  const inactivityInterval = `${config.inactivityMinutes} minutes`;

  const rows = await sql<{ id: string }[]>`
    WITH last_msg AS (
      SELECT conversation_id, MAX(created_at) AS last_at
      FROM messages
      GROUP BY conversation_id
    )
    SELECT c.id
    FROM conversations c
    LEFT JOIN last_msg lm ON lm.conversation_id = c.id
    WHERE c.ingestion_status = 'pending'
      AND (
        c.ended_at IS NOT NULL
        OR (lm.last_at IS NOT NULL AND lm.last_at < NOW() - ${inactivityInterval}::interval)
        OR c.message_count >= ${config.lengthThreshold}
      )
    LIMIT 100
  `;

  for (const row of rows) {
    await producer.enqueueSession({ conversationId: row.id });
  }
  if (rows.length > 0) {
    logger.info({ count: rows.length }, "boundary_scan_enqueued");
  }
  return { enqueued: rows.length };
}
