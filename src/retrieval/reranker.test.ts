import { describe, expect, it } from "vitest";

import { CohereReranker, PassthroughReranker } from "./reranker.js";

describe("PassthroughReranker", () => {
  it("preserves input order and trims to topN", async () => {
    const r = new PassthroughReranker();
    const out = await r.rerank({
      query: "anything",
      documents: [
        { id: "a", text: "..." },
        { id: "b", text: "..." },
        { id: "c", text: "..." },
      ],
      topN: 2,
    });
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
    expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? Number.NEGATIVE_INFINITY);
  });

  it("returns an empty array on empty input", async () => {
    const r = new PassthroughReranker();
    const out = await r.rerank({ query: "x", documents: [], topN: 5 });
    expect(out).toEqual([]);
  });
});

describe("CohereReranker", () => {
  it("posts the expected payload and maps results back to ids", async () => {
    const captured: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: unknown, init?: { body?: unknown }) => {
      captured.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.92 },
            { index: 0, relevance_score: 0.34 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const r = new CohereReranker({
      apiKey: "test",
      model: "rerank-v3.5",
      fetchImpl: fakeFetch,
    });
    const out = await r.rerank({
      query: "what is the capital of france",
      documents: [
        { id: "doc-a", text: "Paris is the capital of France." },
        { id: "doc-b", text: "Berlin is the capital of Germany." },
      ],
      topN: 2,
    });
    expect(captured[0]?.url).toContain("/v2/rerank");
    expect(captured[0]?.body.model).toBe("rerank-v3.5");
    expect(out.map((h) => h.id)).toEqual(["doc-b", "doc-a"]);
    expect(out[0]?.score).toBeCloseTo(0.92, 6);
  });
});
