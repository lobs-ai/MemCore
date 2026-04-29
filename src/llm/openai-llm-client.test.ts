import { describe, expect, it, vi } from "vitest";
import { ProviderError, RateLimitError } from "../errors.js";
import { OpenAILLMClient } from "./openai-llm-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function chatBody(content: string, finish_reason = "stop") {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  };
}

describe("OpenAILLMClient", () => {
  it("requires apiKey", () => {
    expect(
      () =>
        new OpenAILLMClient({
          apiKey: "",
          fetchImpl: () => Promise.reject(new Error("x")),
        }),
    ).toThrow();
  });

  it("posts to /chat/completions and translates system + messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(chatBody("hi there")));
    const client = new OpenAILLMClient({
      apiKey: "secret",
      baseUrl: "https://api.example.com/v1",
      fetchImpl,
    });
    const out = await client.createMessage({
      model: "gpt-4o-mini",
      system: "be brief",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
      temperature: 0.2,
    });
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
      max_tokens: 50,
      temperature: 0.2,
    });
    expect(out.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(out.stopReason).toBe("end_turn");
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it("falls back to defaultModel when params.model is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(chatBody("ok")));
    const client = new OpenAILLMClient({
      apiKey: "k",
      defaultModel: "gpt-4o-mini",
      fetchImpl,
    });
    await client.createMessage({ model: "", system: "", messages: [], maxTokens: 10 });
    const init1 = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse((init1?.body as string) ?? "{}");
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("omits temperature when not provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(chatBody("ok")));
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    await client.createMessage({ model: "m", system: "s", messages: [], maxTokens: 10 });
    const init1 = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse((init1?.body as string) ?? "{}");
    expect("temperature" in body).toBe(false);
  });

  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["weird", "stop"],
  ])("maps finish_reason %s to stop reason %s", async (finish, mapped) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(chatBody("ok", finish)));
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    const out = await client.createMessage({
      model: "m",
      system: "",
      messages: [],
      maxTokens: 1,
    });
    expect(out.stopReason).toBe(mapped);
  });

  it("treats null content as empty string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      }),
    );
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    const out = await client.createMessage({
      model: "m",
      system: "",
      messages: [],
      maxTokens: 1,
    });
    expect(out.content).toEqual([{ type: "text", text: "" }]);
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("maps 429 to RateLimitError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate", { status: 429 }));
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    await expect(
      client.createMessage({ model: "m", system: "", messages: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("wraps non-2xx as ProviderError including status + body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    await expect(
      client.createMessage({ model: "m", system: "", messages: [], maxTokens: 1 }),
    ).rejects.toThrow(/500/);
  });

  it("wraps fetch errors as ProviderError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENETUNREACH"));
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    await expect(
      client.createMessage({ model: "m", system: "", messages: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws when no choices come back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    const client = new OpenAILLMClient({ apiKey: "k", fetchImpl });
    await expect(
      client.createMessage({ model: "m", system: "", messages: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
