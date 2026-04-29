/**
 * Smoke test: VERSION must equal package.json#version. The contract is
 * "bump in package.json, nothing else" — this test catches accidental
 * second sources of truth (a literal in src/version.ts, a hand-typed bump
 * elsewhere, etc.).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches package.json#version", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a non-empty semver-like string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
