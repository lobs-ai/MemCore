import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "api/main": "src/api/main.ts",
    "api/server": "src/api/server.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
});
