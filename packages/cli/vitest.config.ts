import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import shared from "@ynm/vitest-config";
import { defineConfig, mergeConfig, type Plugin } from "vitest/config";

const src = fileURLToPath(new URL("./src/", import.meta.url));
const dist = fileURLToPath(new URL("./dist/", import.meta.url));

/**
 * Under `test:coverage` (c8 sets NODE_V8_COVERAGE) the tests that import source load the built
 * dist JS instead, natively, so in-process and spawned `ynm` runs execute the same scripts and
 * c8 maps both through tsc's source maps into one consistent report.
 */
const builtSourceUnderCoverage: Plugin = {
  name: "ynm-cli-built-source-under-coverage",
  enforce: "pre",
  async resolveId(id, importer, options) {
    if (!process.env.NODE_V8_COVERAGE) return null;
    const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
    const file = resolved?.id;
    if (!file?.startsWith(src) || !file.endsWith(".ts") || file.endsWith(".test.ts")) return null;
    const built = `${dist}${file.slice(src.length, -".ts".length)}.js`;
    return existsSync(built) ? built : null;
  },
};

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [builtSourceUnderCoverage],
    test: {
      testTimeout: 60_000,
      server: { deps: { external: [/\/packages\/cli\/dist\//] } },
    },
  })
);
