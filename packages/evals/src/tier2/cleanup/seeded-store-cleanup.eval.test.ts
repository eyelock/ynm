import { dream } from "@ynm/service";
import { recordMetric } from "../../baseline.js";
import { availableJudges, judgeTag, pairKey, precisionRecall, seeded } from "../support.js";

/** Small by default: real keys cost money; raise YNM_EVAL_CLEANUP_SIZE deliberately. */
const SIZE = Number(process.env.YNM_EVAL_CLEANUP_SIZE ?? 120);

/**
 * Seeded-store cleanup: a store seeded with 5% duplicates and 2% contradictions is cleaned by one
 * dream run within baseline, at a recorded cost. Runs with the best available judge.
 */
describe("tier2 cleanup: one dream run cleans a seeded store", () => {
  const judge = availableJudges().at(-1) as NonNullable<ReturnType<typeof availableJudges>[0]>;
  it(`${judge.name}: ${SIZE} memories, 5% duplicates, 2% contradictions`, async () => {
    const writer = {
      name: "none" as const,
      write: async () => {
        throw new Error("none");
      },
    };
    const { ynm, corpus, config, now } = await seeded(
      { seed: 77, count: SIZE, duplicateRate: 0.05, contradictionRate: 0.02 },
      judge,
      writer
    );
    const before = (await ynm.list()).length;
    const t0 = performance.now();
    const report = await dream(
      ynm,
      { passes: ["expire", "dedupe", "contradict", "normalise"], maxPairs: SIZE * 2 },
      { judge, writer, config, now }
    );
    const ms = performance.now() - t0;
    const after = await ynm.list();
    const truthDup = new Set(corpus.duplicates.map(([a, b]) => pairKey(a, b)));
    const predicted = new Set<string>();
    for (const r of await ynm.records({ includeTombstoned: true })) {
      const data = r.data as
        | { pair?: [string, string]; judgments?: Array<{ pass: string; band?: string }> }
        | undefined;
      if (
        data?.pair &&
        data.judgments?.[0]?.pass === "dedupe" &&
        data.judgments[0].band !== "ignore"
      )
        predicted.add(pairKey(data.pair[0], data.pair[1]));
    }
    const pr = precisionRecall(predicted, truthDup);
    const tag = judgeTag(judge);
    console.info(
      `${judge.name}: ${before} -> ${after.length} memories in ${(ms / 1000).toFixed(1)}s; dedupe P=${pr.precision.toFixed(2)} R=${pr.recall.toFixed(2)}; judged ${report.passes.dedupe?.judged}; est $${report.estimatedCostUsd.toFixed(4)}; flagged ${report.passes.dedupe?.flagged.length}`
    );
    const results = [
      recordMetric(
        { name: `cleanup-dedupe-precision:${tag}`, size: SIZE, value: pr.precision },
        0.05
      ),
      recordMetric({ name: `cleanup-dedupe-recall:${tag}`, size: SIZE, value: pr.recall }, 0.05),
    ];
    recordMetric(
      { name: `cleanup-cost-usd:${tag}`, size: SIZE, value: report.estimatedCostUsd },
      Number.POSITIVE_INFINITY
    );
    recordMetric(
      { name: `cleanup-seconds:${tag}`, size: SIZE, value: ms / 1000 },
      Number.POSITIVE_INFINITY
    );
    expect(results.some((r) => r.regressed)).toBe(false);
    if (judge.calibrated) {
      expect(after.length).toBeLessThan(before);
      expect(report.estimatedCostUsd).toBeLessThan(1);
    }
  }, 3_600_000);
});
