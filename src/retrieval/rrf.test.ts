import { describe, expect, it } from "vitest";

import { fuseRanks } from "./rrf.js";

describe("fuseRanks", () => {
  it("returns an empty array for empty input", () => {
    expect(fuseRanks([])).toEqual([]);
  });

  it("ranks a single list by its order with k+rank scoring", () => {
    const out = fuseRanks([["a", "b", "c"]], { k: 60 });
    expect(out.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(out[0]?.score).toBeCloseTo(1 / 61, 6);
    expect(out[1]?.score).toBeCloseTo(1 / 62, 6);
  });

  it("sums contributions across lists", () => {
    // "a" is rank 1 in both lists, "b" is rank 2 in both, "c" only in list one.
    const out = fuseRanks(
      [
        ["a", "b", "c"],
        ["a", "b"],
      ],
      { k: 60 },
    );
    expect(out.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(out[0]?.score).toBeCloseTo(2 / 61, 6);
    expect(out[1]?.score).toBeCloseTo(2 / 62, 6);
    expect(out[2]?.score).toBeCloseTo(1 / 63, 6);
  });

  it("promotes documents that appear in multiple lists over single-list winners", () => {
    // "x" is rank 1 in list 0, "y" is rank 5 in list 0 but rank 1 in list 1.
    // y's combined score (1/61 + 1/65) should beat x's single 1/61.
    const out = fuseRanks([["x", "a", "b", "c", "y"], ["y"]], { k: 60 });
    expect(out[0]?.id).toBe("y");
    expect(out[1]?.id).toBe("x");
  });

  it("respects the limit option", () => {
    const out = fuseRanks([["a", "b", "c", "d"]], { limit: 2 });
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("records per-list contributions for debugging", () => {
    const out = fuseRanks([
      ["a", "b"],
      ["b", "a"],
    ]);
    const a = out.find((h) => h.id === "a");
    expect(a?.contributions).toHaveLength(2);
    expect(a?.contributions.map((c) => c.listIndex).sort()).toEqual([0, 1]);
  });
});
