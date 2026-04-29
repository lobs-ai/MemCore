/**
 * API surface tests using fastify.inject + a hand-rolled MemCore stub.
 *
 * The real MemCore class owns a postgres pool and an LLM client; for route-
 * level tests we only need an object that exposes the same async methods, so
 * we cast a stub through `unknown`. This keeps the tests free of Postgres
 * and network dependencies.
 */

import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../errors.js";
import type { MemCore } from "../memcore.js";
import { buildServer } from "./server.js";

interface SearchHit {
  memory: {
    id: string;
    content: string;
    category: string;
    status: string;
    version: number;
    confidence: number;
    documentDate: Date | null;
    eventDate: Date | null;
    eventDatePrecision: string | null;
    promptVersion: string;
    extractorModel: string;
    score: number;
    chunks: never[];
  };
  score: number;
  relatedMemories: never[];
}

interface MemCoreStubOverrides {
  ping?: () => Promise<boolean>;
  add?: (args: unknown) => Promise<unknown>;
  search?: (args: unknown) => Promise<unknown>;
  buildProfile?: (args: unknown) => Promise<unknown>;
  getProfile?: (args: unknown) => Promise<unknown>;
}

function memcoreStub(overrides: MemCoreStubOverrides = {}): MemCore {
  return {
    version: "9.9.9-test",
    ping: overrides.ping ?? (async () => true),
    add: overrides.add ?? (async () => ({ conversationId: "c-1", ingestionStatus: "complete" })),
    search:
      overrides.search ??
      (async () => ({
        results: [],
        profile: null,
        queryMetadata: {
          totalCandidates: 0,
          latencyMs: 1,
          dateRange: null,
          shouldAbstain: true,
          abstainReason: "no_candidates",
          profileRelevant: false,
        },
      })),
    buildProfile: overrides.buildProfile ?? (async () => null),
    getProfile: overrides.getProfile ?? (async () => null),
    close: async () => {},
  } as unknown as MemCore;
}

function makeApp(overrides: MemCoreStubOverrides = {}) {
  return buildServer({ memcore: memcoreStub(overrides) });
}

const sampleHit: SearchHit = {
  memory: {
    id: "00000000-0000-0000-0000-000000000001",
    content: "User prefers TypeScript",
    category: "preference",
    status: "active",
    version: 1,
    confidence: 0.9,
    documentDate: new Date("2026-04-29T00:00:00Z"),
    eventDate: null,
    eventDatePrecision: null,
    promptVersion: "v2",
    extractorModel: "gpt-4o-mini",
    score: 1,
    chunks: [],
  },
  score: 1,
  relatedMemories: [],
};

describe("GET /v1/health", () => {
  it("returns 200 with version when ping resolves true", async () => {
    const app = makeApp({ ping: async () => true });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok", version: "9.9.9-test" });
    await app.close();
  });

  it("returns 503 with version when ping resolves false", async () => {
    const app = makeApp({ ping: async () => false });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", db: "down", version: "9.9.9-test" });
    await app.close();
  });

  it("returns 503 when ping throws", async () => {
    const app = makeApp({
      ping: async () => {
        throw new Error("db down");
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("POST /v1/add", () => {
  it("validates that container_tag is required", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/add",
      payload: { content: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    await app.close();
  });

  it("rejects when both content and messages are present", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/add",
      payload: {
        container_tag: "u",
        content: "x",
        messages: [{ role: "user", content: "y" }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects when neither content nor messages are present", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/add",
      payload: { container_tag: "u" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("calls memcore.add and returns 202 with conversation id + status", async () => {
    const add = vi.fn().mockResolvedValue({ conversationId: "abc", ingestionStatus: "complete" });
    const app = makeApp({ add });
    const res = await app.inject({
      method: "POST",
      url: "/v1/add",
      payload: { container_tag: "user_42", content: "hello" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: "abc", ingestion_status: "complete" });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: "user_42", content: "hello" }),
    );
    await app.close();
  });

  it("maps ValidationError thrown from MemCore to a 400 with the right code", async () => {
    const app = makeApp({
      add: async () => {
        throw new ValidationError("nope", { reason: "bad" });
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/add",
      payload: { container_tag: "u", content: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_error", message: "nope" });
    await app.close();
  });
});

describe("POST /v1/search", () => {
  it("requires container_tag and query", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/search", payload: { query: "x" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns search results, profile envelope, and abstain metadata", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [sampleHit],
      profile: {
        content: "**Identity**: Maya",
        version: 3,
        generatedAt: new Date("2026-04-29T12:00:00Z"),
        sourceMemoryCount: 7,
      },
      queryMetadata: {
        totalCandidates: 1,
        latencyMs: 42,
        dateRange: null,
        shouldAbstain: false,
        abstainReason: null,
        profileRelevant: true,
      },
    });
    const app = makeApp({ search });
    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { container_tag: "user_42", query: "about me" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].memory.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(body.profile).toMatchObject({ version: 3, source_memory_count: 7 });
    expect(body.query_metadata.profile_relevant).toBe(true);
    expect(body.query_metadata.should_abstain).toBe(false);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: "user_42", query: "about me" }),
    );
    await app.close();
  });

  it("propagates abstain metadata when no results survive", async () => {
    const app = makeApp(); // default stub returns abstain
    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { container_tag: "u", query: "q" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toEqual([]);
    expect(body.query_metadata.should_abstain).toBe(true);
    expect(body.query_metadata.abstain_reason).toBe("no_candidates");
    await app.close();
  });

  it("forwards an explicit dateRange object", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [],
      profile: null,
      queryMetadata: {
        totalCandidates: 0,
        latencyMs: 1,
        dateRange: {
          axis: "event_date",
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-12-31T00:00:00Z"),
        },
        shouldAbstain: false,
        abstainReason: null,
        profileRelevant: false,
      },
    });
    const app = makeApp({ search });
    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: {
        container_tag: "u",
        query: "tokyo",
        filters: {
          date_range: {
            axis: "event_date",
            from: "2026-01-01T00:00:00Z",
            to: "2026-12-31T00:00:00Z",
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const args = search.mock.calls[0]?.[0];
    expect(args.dateRange).toBeDefined();
    expect(args.dateRange.axis).toBe("event_date");
    expect(args.dateRange.from).toBeInstanceOf(Date);
    expect(args.dateRange.to).toBeInstanceOf(Date);
    await app.close();
  });

  it("treats explicit null dateRange as opt-out", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [],
      profile: null,
      queryMetadata: {
        totalCandidates: 0,
        latencyMs: 1,
        dateRange: null,
        shouldAbstain: false,
        abstainReason: null,
        profileRelevant: false,
      },
    });
    const app = makeApp({ search });
    await app.inject({
      method: "POST",
      url: "/v1/search",
      payload: { container_tag: "u", query: "q", filters: { date_range: null } },
    });
    const args = search.mock.calls[0]?.[0];
    expect(args.dateRange).toBeNull();
    await app.close();
  });
});

describe("/v1/profiles", () => {
  it("POST /profiles/build returns 200 with the new row", async () => {
    const buildProfile = vi.fn().mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000099",
      containerId: "00000000-0000-0000-0000-000000000001",
      content: "**Identity**: Maya",
      sourceMemoryIds: [],
      sourceMemoryCount: 5,
      version: 2,
      promptVersion: "v1",
      generatorModel: "gpt-4o-mini",
      generatedAt: new Date("2026-04-29T12:00:00Z"),
    });
    const app = makeApp({ buildProfile });
    const res = await app.inject({
      method: "POST",
      url: "/v1/profiles/build",
      payload: { container_tag: "user_42" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      container_tag: "user_42",
      version: 2,
      source_memory_count: 5,
      generator_model: "gpt-4o-mini",
    });
    expect(buildProfile).toHaveBeenCalledWith({ containerTag: "user_42" });
    await app.close();
  });

  it("POST /profiles/build returns 404 when buildProfile resolves null", async () => {
    const app = makeApp({ buildProfile: async () => null });
    const res = await app.inject({
      method: "POST",
      url: "/v1/profiles/build",
      payload: { container_tag: "missing" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    await app.close();
  });

  it("GET /profiles/:tag returns the stored profile", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000099",
      containerId: "00000000-0000-0000-0000-000000000001",
      content: "**Identity**: Maya",
      sourceMemoryIds: [],
      sourceMemoryCount: 5,
      version: 1,
      promptVersion: "v1",
      generatorModel: "gpt-4o-mini",
      generatedAt: new Date("2026-04-29T12:00:00Z"),
    });
    const app = makeApp({ getProfile });
    const res = await app.inject({ method: "GET", url: "/v1/profiles/user_42" });
    expect(res.statusCode).toBe(200);
    expect(res.json().container_tag).toBe("user_42");
    expect(getProfile).toHaveBeenCalledWith({ containerTag: "user_42" });
    await app.close();
  });

  it("GET /profiles/:tag returns 404 when none stored", async () => {
    const app = makeApp({ getProfile: async () => null });
    const res = await app.inject({ method: "GET", url: "/v1/profiles/none" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /profiles/build validates container_tag presence", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/profiles/build",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
