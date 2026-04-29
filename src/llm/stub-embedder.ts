/**
 * Deterministic stub embedder for tests and OPENAI_API_KEY-less local dev.
 *
 * Hashes input text to a fixed-length vector. Embeddings are L2-normalised so
 * cosine similarity behaves sensibly. The vectors carry no semantic meaning —
 * two near-identical strings will have wildly different embeddings — so this
 * stub is only suitable for plumbing tests, not retrieval-quality work.
 *
 * The eval harness always uses a real embedder. This stub exists so unit
 * tests and the boot path don't need network access or API keys.
 */

import { createHash } from "node:crypto";
import type { Embedder } from "./embedder.js";
import type { EmbeddingResponse } from "./types.js";

export class StubEmbedder implements Embedder {
  constructor(
    private readonly dim = 3072,
    private readonly model = "stub-embedder",
  ) {
    if (dim <= 0) throw new Error("dim must be positive");
  }

  async embed({ texts }: { texts: string[] }): Promise<EmbeddingResponse> {
    const vectors = texts.map((t) => this.embedOne(t));
    const approxTokens = texts.reduce((acc, t) => acc + Math.max(1, t.split(/\s+/).length), 0);
    return {
      vectors,
      model: this.model,
      usage: { inputTokens: approxTokens, outputTokens: 0 },
    };
  }

  private embedOne(text: string): number[] {
    // Stretch SHA-256 over `dim` floats by hashing successive (counter, text)
    // blocks. Cheap, stable across processes, no external state.
    const out: number[] = [];
    let counter = 0;
    while (out.length < this.dim) {
      const digest = createHash("sha256").update(`${counter}:${text}`).digest();
      for (let i = 0; i + 4 <= digest.length && out.length < this.dim; i += 4) {
        const value = digest.readUInt32BE(i);
        out.push((value / 0xffffffff) * 2 - 1);
      }
      counter += 1;
    }
    let norm = 0;
    for (const v of out) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return out.map((v) => v / norm);
  }
}
