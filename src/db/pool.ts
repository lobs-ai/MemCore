/**
 * Process-wide postgres pool used by scripts (db:reset) and the Fastify server.
 *
 * The `MemCore` SDK class manages its own pool — multiple instances each get
 * their own. This module is for code paths that don't sit behind a class
 * instance (the schema-reset script, server health checks).
 */

import postgres from "postgres";
import { getSettings } from "../config.js";

let pool: postgres.Sql | null = null;

export function getPool(): postgres.Sql {
  if (pool) return pool;
  const settings = getSettings();
  pool = postgres(settings.databaseUrl, { onnotice: () => {} });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end({ timeout: 5 });
    pool = null;
  }
}
