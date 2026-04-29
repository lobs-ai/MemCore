/**
 * Prompt file loader.
 *
 * Prompts live as inert text in this directory and are read at startup.
 * Versioning is by filename suffix (`extraction_v1.txt`, `extraction_v2.txt`).
 * Memories store the version they were extracted with so we can re-extract
 * when prompts change.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;
  const here = fileURLToPath(new URL(".", import.meta.url));
  const text = readFileSync(resolve(here, `${name}.txt`), "utf8");
  cache.set(name, text);
  return text;
}

export function format(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`missing prompt variable: ${key}`);
    return vars[key] ?? "";
  });
}

export const EXTRACTION_PROMPT_VERSION = "v2";
export const CONTEXTUALIZER_PROMPT_VERSION = "v1";
export const CONFLICT_DETECTOR_PROMPT_VERSION = "v1";
export const TEMPORAL_PARSER_PROMPT_VERSION = "v1";
