import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Shared vitest config. Unit tests sit next to code; integration tests live in test/.
 *
 * Coverage has no global thresholds: CI gates on the lines a change adds or modifies
 * (scripts/coverage-diff.mjs, reading each package's coverage/lcov.info), so overall totals
 * are reported but never fail a run.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // A developer running ynr has a spool at ~/.local/state/ynr/spool/local, which would turn
    // telemetry on in every test; point it somewhere that does not exist. Tests that want a
    // spool set YNR_SPOOL themselves.
    env: { YNR_SPOOL: "", XDG_STATE_HOME: join(tmpdir(), "ynm-test-no-xdg-state") },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts"],
    },
  },
});
