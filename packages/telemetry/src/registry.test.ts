import { readFileSync } from "node:fs";
// @ts-expect-error: the generator is plain JavaScript, run by `make gen`
import { generate, OUTPUT } from "../../../scripts/gen-telemetry.mjs";
import { METRIC_CARDINALITY_LIMITS, REGISTRY, SEMCONV_VERSION } from "./registry.gen.js";

describe("telemetry registry", () => {
  it("generated constants are current; run `make gen` after changing telemetry/registry", async () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(await generate());
  });

  it("is ynm's, pinned to the installed semantic conventions, with a limit on every metric", () => {
    expect(REGISTRY.name).toBe("ynm");
    expect(SEMCONV_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    const metrics = REGISTRY.groups.filter((g) => g.type === "metric");
    expect(metrics.length).toBeGreaterThan(0);
    for (const m of metrics)
      expect(METRIC_CARDINALITY_LIMITS[(m as { metric_name: string }).metric_name]).toBeGreaterThan(
        0
      );
  });
});
