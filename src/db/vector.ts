/**
 * Format a `number[]` as a pgvector literal.
 *
 * postgres.js doesn't ship a vector codec, so we render embeddings as the
 * `[1.0,2.0,...]` text form pgvector accepts and cast at the SQL site with
 * `${literal}::vector`.
 */

export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
