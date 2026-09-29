import shared from "@ynm/vitest-config";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(shared, defineConfig({ test: { testTimeout: 120_000 } }));
