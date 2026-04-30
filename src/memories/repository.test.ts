/**
 * Integration tests for the memory repository.
 *
 * Hits a real Postgres so we exercise the JSONB / vector / status filtering
 * paths the SDK depends on. The test self-skips when DATABASE_URL isn't
 * reachable so contributors without a local stack can still run the rest of
 * the suite.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archiveMemory,
  findSimilarMemories,
  getMemoryById,
  insertMemory,
  listMemories,
  recordMemoryUse,
  updateMemory,
} from "./repository.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/memcore";

let sql: postgres.Sql | null = null;
let dbAvailable = false;
const TAG_A = `repo-test-a-${Date.now()}`;
const TAG_B = `repo-test-b-${Date.now()}`;

beforeAll(async () => {
  try {
    sql = postgres(DATABASE_URL, { onnotice: () => {}, max: 4 });
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    if (sql) await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
  }
});

afterAll(async () => {
  if (sql) {
    await sql`DELETE FROM containers WHERE tag IN (${TAG_A}, ${TAG_B})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
});

function unitVector(seed: number, dim = 8): number[] {
  // Build a deterministic, normalized vector so cosine distances are stable.
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

describe("memory repository (integration)", () => {
  it("inserts a memory, reads it back, lists it, and archives it", async () => {
    if (!dbAvailable || !sql) {
      console.warn("DATABASE_URL unreachable — skipping repository integration tests");
      return;
    }

    const inserted = await insertMemory(sql, {
      containerTag: TAG_A,
      content: "User's primary stack is TypeScript and Postgres.",
      embedding: unitVector(1),
      category: "fact",
      metadata: { type: "user", source: "manual" },
      promptVersion: "manual",
      extractorModel: "manual",
    });
    expect(inserted.id).toBeTruthy();
    expect(inserted.metadata).toMatchObject({ type: "user", source: "manual" });
    expect(inserted.useCount).toBe(0);
    expect(inserted.lastUsedAt).toBeNull();

    const fetched = await getMemoryById(sql, TAG_A, inserted.id);
    expect(fetched?.id).toBe(inserted.id);

    const wrongContainer = await getMemoryById(sql, TAG_B, inserted.id);
    expect(wrongContainer).toBeNull();

    const list = await listMemories(sql, {
      containerTag: TAG_A,
      filters: { metadata: { type: "user" } },
    });
    expect(list.find((r) => r.id === inserted.id)).toBeTruthy();

    const archived = await archiveMemory(sql, TAG_A, inserted.id);
    expect(archived.status).toBe("archived");

    const activeOnly = await listMemories(sql, {
      containerTag: TAG_A,
      filters: { status: "active", metadata: { type: "user" } },
    });
    expect(activeOnly.find((r) => r.id === inserted.id)).toBeUndefined();
  });

  it("updates content and bumps version; metadata-only edits don't bump version", async () => {
    if (!dbAvailable || !sql) return;

    const original = await insertMemory(sql, {
      containerTag: TAG_A,
      content: "User loves Rust.",
      embedding: unitVector(2),
      category: "preference",
      metadata: { type: "user" },
      promptVersion: "manual",
      extractorModel: "manual",
    });
    expect(original.version).toBe(1);

    const metadataEdit = await updateMemory(sql, {
      containerTag: TAG_A,
      id: original.id,
      metadata: { type: "user", flagged: true },
    });
    expect(metadataEdit.version).toBe(1);
    expect(metadataEdit.metadata).toMatchObject({ flagged: true });

    const contentEdit = await updateMemory(sql, {
      containerTag: TAG_A,
      id: original.id,
      content: "User now prefers Go.",
      embedding: unitVector(3),
    });
    expect(contentEdit.version).toBe(2);
    expect(contentEdit.content).toBe("User now prefers Go.");
  });

  it("recordMemoryUse increments use_count and stamps last_used_at", async () => {
    if (!dbAvailable || !sql) return;

    const inserted = await insertMemory(sql, {
      containerTag: TAG_A,
      content: "Tracker test memory.",
      embedding: unitVector(4),
      category: "fact",
      promptVersion: "manual",
      extractorModel: "manual",
    });
    await recordMemoryUse(sql, TAG_A, [inserted.id]);
    await recordMemoryUse(sql, TAG_A, [inserted.id]);

    const after = await getMemoryById(sql, TAG_A, inserted.id);
    expect(after?.useCount).toBe(2);
    expect(after?.lastUsedAt).toBeTruthy();
  });

  it("findSimilarMemories ranks by cosine similarity and filters by status", async () => {
    if (!dbAvailable || !sql) return;

    const seedVec = unitVector(5);
    const close = await insertMemory(sql, {
      containerTag: TAG_B,
      content: "Close match.",
      embedding: seedVec,
      category: "fact",
      promptVersion: "manual",
      extractorModel: "manual",
    });
    await insertMemory(sql, {
      containerTag: TAG_B,
      content: "Far match.",
      embedding: unitVector(99),
      category: "fact",
      promptVersion: "manual",
      extractorModel: "manual",
    });

    const matches = await findSimilarMemories(sql, {
      containerTag: TAG_B,
      embedding: seedVec,
      threshold: 0.99,
    });
    expect(matches[0]?.id).toBe(close.id);
    expect(matches[0]?.similarity).toBeGreaterThan(0.99);
    expect(matches.length).toBe(1);
  });

  it("listMemories filters by metadata containment and respects sort", async () => {
    if (!dbAvailable || !sql) return;

    const a = await insertMemory(sql, {
      containerTag: TAG_B,
      content: "Tagged feedback memory.",
      embedding: unitVector(10),
      category: "preference",
      metadata: { type: "feedback", priority: "high" },
      promptVersion: "manual",
      extractorModel: "manual",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await insertMemory(sql, {
      containerTag: TAG_B,
      content: "Newer feedback memory.",
      embedding: unitVector(11),
      category: "preference",
      metadata: { type: "feedback", priority: "high" },
      promptVersion: "manual",
      extractorModel: "manual",
    });

    const recency = await listMemories(sql, {
      containerTag: TAG_B,
      filters: { metadata: { type: "feedback" } },
      sort: "recency",
    });
    const ids = recency.map((r) => r.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });
});
