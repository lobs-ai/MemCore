import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "api/main": "src/api/main.ts",
    "api/server": "src/api/server.ts",
    "queue/main": "src/queue/main.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  // Prompt loader (src/prompts/loader.ts) reads `${name}.txt` relative to its
  // own bundled location — i.e. dist/. Copy the prompt text files alongside
  // the bundled output so readFileSync resolves at runtime.
  onSuccess: async () => {
    const src = "src/prompts";
    const dst = "dist";
    for (const f of readdirSync(src)) {
      if (f.endsWith(".txt")) copyFileSync(join(src, f), join(dst, f));
    }
  },
});
