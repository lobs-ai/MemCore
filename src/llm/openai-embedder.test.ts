import { describe, expect, it, vi } from "vitest";
import { ProviderError, RateLimitError } from "../errors.js";
import { OpenAIEmbedder } from "./openai-embedder.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("OpenAIEmbedder", () => {
  it("requires an apiKey", () => {
    expect(
      () =>
        new OpenAIEmbedder({
          apiKey: "",
          model: "x",
          fetchImpl: () => Promise.reject(new Error("nope")),
        }),
    ).toThrow();
  });

  it("posts to /embeddings with bearer auth and the configured model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { embedding: [0.1, 0.2], index: 0 },
          { embedding: [0.3, 0.4], index: 1 },
        ],
        usage: { prompt_tokens: 17 },
      }),
    );
    const emb = new OpenAIEmbedder({
      apiKey: "secret",
      model: "text-embedding-3-large",
      baseUrl: "https://example.com/v1/",
      fetchImpl,
    });
    const out = await emb.embed({ texts: ["a", "b"] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("https://example.com/v1/embeddings");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: "text-embedding-3-large", input: ["a", "b"] });
    expect(out.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(out.usage.inputTokens).toBe(17);
    expect(out.model).toBe("text-embedding-3-large");
  });

  it("short-circuits an empty input list without a network call", async () => {
    const fetchImpl = vi.fn();
    const emb = new OpenAIEmbedder({ apiKey: "k", model: "m", fetchImpl });
    const out = await emb.embed({ texts: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.vectors).toEqual([]);
  });

  it("maps a 429 to RateLimitError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate", { status: 429 }));
    const emb = new OpenAIEmbedder({ apiKey: "k", model: "m", fetchImpl });
    await expect(emb.embed({ texts: ["x"] })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("wraps other non-2xx responses as ProviderError including the body", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("server boom", { status: 500 })));
    const emb = new OpenAIEmbedder({ apiKey: "k", model: "m", fetchImpl });
    let caught: unknown;
    try {
      await emb.embed({ texts: ["x"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as Error).message).toMatch(/500/);
  });

  it("wraps fetch errors as ProviderError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const emb = new OpenAIEmbedder({ apiKey: "k", model: "m", fetchImpl });
    await expect(emb.embed({ texts: ["x"] })).rejects.toBeInstanceOf(ProviderError);
  });

  it("strips a trailing slash from the base url", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ embedding: [1], index: 0 }] }));
    const emb = new OpenAIEmbedder({
      apiKey: "k",
      model: "m",
      baseUrl: "http://localhost:1234/v1/",
      fetchImpl,
    });
    await emb.embed({ texts: ["x"] });
    const url = fetchImpl.mock.calls[0]?.[0] as string | undefined;
    expect(url).toBe("http://localhost:1234/v1/embeddings");
  });
});
