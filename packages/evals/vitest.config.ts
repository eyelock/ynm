import shared from "@ynm/vitest-config";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      fileParallelism: false,
    },
  })
);
