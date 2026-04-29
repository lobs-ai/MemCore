/**
 * Token-based fixed-size chunker (Phase 1 baseline).
 *
 * Splits text into chunks of `target` tokens with `overlap` tokens between
 * adjacent chunks. No semantic boundary detection — that's Phase 3 (semantic
 * chunker per SPEC.md § Ingestion pipeline). The simplest possible split is
 * the right Phase 1 control to measure later improvements against.
 *
 * Tokenization uses gpt-tokenizer's cl100k_base. Not the exact tokenizer of
 * the embedding model, but close enough for chunk-size control. Real model
 * tokens differ by a few percent; we don't need precision here.
 */

import { decode, encode } from "gpt-tokenizer";

import { ChunkingError } from "../errors.js";

export interface ChunkRecord {
  content: string;
  position: number;
  tokenCount: number;
}

export interface ChunkOptions {
  targetTokens: number;
  minTokens: number;
  overlapTokens?: number;
}

export function chunkText(text: string, opts: ChunkOptions): ChunkRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const target = opts.targetTokens;
  const floor = opts.minTokens;
  const overlap = opts.overlapTokens ?? 50;
  if (target <= 0) throw new ChunkingError("targetTokens must be positive");
  if (overlap < 0 || overlap >= target) {
    throw new ChunkingError("overlapTokens must be in [0, targetTokens)");
  }

  const tokenIds = encode(text);
  const total = tokenIds.length;
  if (total === 0) return [];
  if (total <= floor) {
    return [{ content: text, position: 0, tokenCount: total }];
  }

  const step = target - overlap;
  const chunks: ChunkRecord[] = [];
  let start = 0;
  let position = 0;
  while (start < total) {
    const end = Math.min(start + target, total);
    const sliceIds = tokenIds.slice(start, end);
    // Decoding round-trips a token slice back to a string. The tokenizer
    // handles multi-byte boundaries safely — we never split UTF-8 mid-codepoint.
    const content = decode(sliceIds);
    chunks.push({ content, position, tokenCount: sliceIds.length });
    position += 1;
    if (end === total) break;
    start += step;
  }
  return chunks;
}
