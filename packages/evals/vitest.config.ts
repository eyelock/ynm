import shared from "@ynm/vitest-config";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Gates spawn built binaries, so they run after `pnpm build` via `pnpm gate M<n>`.
      include: ["src/**/*.test.ts"],
      testTimeout: 60_000,
    },
  })
);
