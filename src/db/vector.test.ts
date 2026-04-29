import { describe, expect, it } from "vitest";
import { vectorLiteral } from "./vector.js";

describe("vectorLiteral", () => {
  it("renders an empty vector as []", () => {
    expect(vectorLiteral([])).toBe("[]");
  });

  it("joins a single value with brackets", () => {
    expect(vectorLiteral([1.5])).toBe("[1.5]");
  });

  it("joins multiple values with commas (no spaces)", () => {
    expect(vectorLiteral([1, 2.25, -3])).toBe("[1,2.25,-3]");
  });

  it("preserves negative zero / floats", () => {
    expect(vectorLiteral([-0.5, 0.001, 100])).toBe("[-0.5,0.001,100]");
  });
});
