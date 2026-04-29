/**
 * Queue payload types.
 *
 * Two job kinds:
 *   - "ingest"        : inputs that arrive via /v1/add. Worker stages the
 *                        conversation row and runs the full pipeline.
 *   - "ingest_session": a conversation flagged for ingestion by the session
 *                        boundary scanner. Worker reloads its messages and
 *                        runs the pipeline against an existing conversation row.
 */

export interface IngestJobData {
  containerTag: string;
  sourceType: string;
  content: string;
  externalId?: string;
  documentDate?: string;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  metadata?: Record<string, unknown>;
}

export interface IngestSessionJobData {
  conversationId: string;
}

export type JobName = "ingest" | "ingest_session";

export const QUEUE_NAME = "memcore-ingestion";
