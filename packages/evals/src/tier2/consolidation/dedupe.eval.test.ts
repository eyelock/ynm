import { dream } from "@ynm/service";
import { recordMetric } from "../../baseline.js";
import {
  availableJudges,
  availableWriter,
  judgeTag,
  pairKey,
  precisionRecall,
  seeded,
} from "../support.js";

/** Small by default: real keys cost money; raise YNM_EVAL_SIZE deliberately. */
const SIZE = Number(process.env.YNM_EVAL_SIZE ?? 60);

/**
 * Dedupe and contradiction precision/recall per Judge (ADR-014 tier 2, ADR-006). Uncalibrated
 * judges cannot act, so their predictions are the pairs they flagged for review.
 */
describe("tier2 consolidation: dedupe and contradict per judge", () => {
  for (const judge of availableJudges()) {
    it(`${judge.name}: precision and recall on a ${SIZE}-memory corpus`, async () => {
      const writer = availableWriter();
      const { ynm, corpus, config, now } = await seeded(
        { seed: 21, count: SIZE, duplicateRate: 0.08, contradictionRate: 0.04 },
        judge,
        { name: "none", write: writer.write.bind(writer) } as typeof writer
      );
      const truthDup = new Set(corpus.duplicates.map(([a, b]) => pairKey(a, b)));
      const truthCon = new Set(corpus.contradictions.map(([a, b]) => pairKey(a, b)));
      const report = await dream(
        ynm,
        { passes: ["dedupe", "contradict"], maxPairs: SIZE * 3 },
        {
          judge,
          writer: {
            name: "none",
            write: async () => {
              throw new Error("no writer in this eval");
            },
          },
          config,
          now,
        }
      );
      const records = await ynm.records({ includeTombstoned: true });
      const predictedDup = new Set<string>();
      const predictedCon = new Set<string>();
      for (const r of records) {
        const data = r.data as
          | { pair?: [string, string]; judgments?: Array<{ pass: string; band?: string }> }
          | undefined;
        const j = data?.judgments?.[0];
        if (!data?.pair || !j) continue;
        const key = pairKey(data.pair[0], data.pair[1]);
        if (j.pass === "dedupe" && (j.band === "act" || j.band === "review")) predictedDup.add(key);
        if (j.pass === "contradict" && (j.band === "act" || j.band === "review"))
          predictedCon.add(key);
      }
      const dup = precisionRecall(predictedDup, truthDup);
      const con = precisionRecall(predictedCon, truthCon);
      const tag = judgeTag(judge);
      const results = [
        recordMetric({ name: `dedupe-precision:${tag}`, size: SIZE, value: dup.precision }, 0.05),
        recordMetric({ name: `dedupe-recall:${tag}`, size: SIZE, value: dup.recall }, 0.05),
        recordMetric(
          { name: `contradict-precision:${tag}`, size: SIZE, value: con.precision },
          0.05
        ),
        recordMetric({ name: `contradict-recall:${tag}`, size: SIZE, value: con.recall }, 0.05),
      ];
      recordMetric(
        { name: `dream-cost-usd:${tag}`, size: SIZE, value: report.estimatedCostUsd },
        Number.POSITIVE_INFINITY
      );
      recordMetric(
        { name: `dream-judged-pairs:${tag}`, size: SIZE, value: report.passes.dedupe?.judged ?? 0 },
        Number.POSITIVE_INFINITY
      );
      console.info(
        `${judge.name}: dedupe P=${dup.precision.toFixed(2)} R=${dup.recall.toFixed(2)} (${dup.tp}/${truthDup.size}); contradict P=${con.precision.toFixed(2)} R=${con.recall.toFixed(2)} (${con.tp}/${truthCon.size}); judged ${report.passes.dedupe?.judged}+${report.passes.contradict?.judged}; est $${report.estimatedCostUsd.toFixed(4)}`
      );
      expect(
        results.some((r) => r.regressed),
        "consolidation quality regressed vs baseline"
      ).toBe(false);
      if (judge.calibrated) expect(dup.recall).toBeGreaterThan(0.5);
    }, 1_800_000);
  }
});
