/**
 * Apply db/schema.sql to the configured database. Destructive: drops every
 * MemCore table first. We accept that for pre-production phases — there's no
 * data worth preserving and migration history would be churn for churn's sake.
 *
 * Usage: pnpm db:reset
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/db/pool.js";
import { getLogger } from "../src/logging.js";

const logger = getLogger("db.reset");

async function main(): Promise<void> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const sqlPath = resolve(here, "schema.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const pool = getPool();
  logger.info({ path: sqlPath }, "applying schema");
  await pool.unsafe(sql);
  logger.info("schema applied");
  await closePool();
}

main().catch(async (err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "db reset failed");
  await closePool();
  process.exit(1);
});
