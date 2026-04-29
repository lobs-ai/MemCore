/**
 * SDK version constant.
 *
 * Sourced from `package.json#version` so there is exactly one source of
 * truth for the SDK version. To bump:
 *
 *   1. Edit `version` in `package.json`.
 *   2. Run `pnpm build`.
 *
 * That's it. No manual edits to this file. The constant is consumed by:
 *
 *   - The `VERSION` named export from `memcore`
 *   - `MemCore.version` (instance accessor)
 *   - The `version` field on `/v1/health`
 *
 * tsup inlines the JSON at build time, so no runtime filesystem read is
 * needed in the published bundle.
 */

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
