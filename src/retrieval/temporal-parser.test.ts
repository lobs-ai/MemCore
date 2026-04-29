import { describe, expect, it } from "vitest";

import { parseResponse } from "./temporal-parser.js";

describe("parseResponse", () => {
  it("returns null on the literal string null", () => {
    expect(parseResponse("null")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseResponse("")).toBeNull();
  });

  it("returns null when no JSON object is present", () => {
    expect(parseResponse("the query has no temporal scope")).toBeNull();
  });

  it("parses a both-bounds event_date range", () => {
    const out = parseResponse('{"axis":"event_date","from":"2025-06-01","to":"2025-08-31"}');
    expect(out?.axis).toBe("event_date");
    expect(out?.from?.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    expect(out?.to?.toISOString()).toBe("2025-08-31T00:00:00.000Z");
  });

  it("parses a from-only document_date range", () => {
    const out = parseResponse('{"axis":"document_date","from":"2025-01-01","to":null}');
    expect(out?.axis).toBe("document_date");
    expect(out?.from?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(out?.to).toBeNull();
  });

  it("returns null when both bounds are null", () => {
    expect(parseResponse('{"axis":"event_date","from":null,"to":null}')).toBeNull();
  });

  it("strips JSON fences", () => {
    const raw = '```json\n{"axis":"event_date","from":"2026-01-01","to":null}\n```';
    expect(parseResponse(raw)?.axis).toBe("event_date");
  });

  it("returns null on invalid axis", () => {
    expect(parseResponse('{"axis":"calendar","from":"2025-01-01","to":null}')).toBeNull();
  });

  it("returns null on garbage JSON", () => {
    expect(parseResponse("{not valid")).toBeNull();
  });
});
