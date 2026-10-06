import { readFileSync } from "node:fs";
// @ts-expect-error: the generator is plain JavaScript, run by `make gen`
import { generate, OUTPUT } from "../../../scripts/gen-telemetry.mjs";
import { METRIC_CARDINALITY_LIMITS, REGISTRY, SEMCONV_VERSION } from "./registry.gen.js";

describe("telemetry registry", () => {
  it("generated constants are current; run `make gen` after changing telemetry/registry", async () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(await generate());
  });

  it("is ynm's, pinned to the installed semantic conventions, with a limit on every metric", () => {
    expect(SEMCONV_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(`v${REGISTRY.semantic_conventions.version}`).toBe(SEMCONV_VERSION);
    expect(REGISTRY.metrics.length).toBeGreaterThan(0);
    for (const m of REGISTRY.metrics) expect(METRIC_CARDINALITY_LIMITS[m.name]).toBeGreaterThan(0);
  });
});
