import shared from "@ynm/vitest-config";
import { defineConfig, mergeConfig } from "vitest/config";

// mergeConfig concatenates arrays, so these excludes add to the shared ones.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      fileParallelism: false,
      coverage: {
        exclude: [
          // Shells out to the docker CLI; exercised only by the hosted suites (make test-hosted).
          "src/tier1/hosted/docker.ts",
          // Loads the repo .env at import and builds paid judges and writers for model-backed evals.
          "src/tier2/support.ts",
        ],
      },
    },
  })
);
