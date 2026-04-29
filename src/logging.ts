/**
 * Structured logging via pino.
 *
 * Every log line carries `component`. `requestId` and `containerTag` are
 * attached per-request through Fastify hooks (see src/api/server.ts).
 */

import { type Logger, pino } from "pino";
import { getSettings } from "./config.js";

let root: Logger | null = null;

function getRoot(): Logger {
  if (root) return root;
  const settings = getSettings();
  root = pino({
    level: settings.logLevel,
    base: { env: settings.environment },
    transport:
      settings.environment === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });
  return root;
}

export function getLogger(component: string, bindings?: Record<string, unknown>): Logger {
  return getRoot().child({ component, ...(bindings ?? {}) });
}

export type { Logger };
