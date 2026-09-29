import { existsSync } from "node:fs";
import { availableJudges, availableWriter, EVAL_GUARD } from "../tier2/support.js";
import { datasetPath, loadLocomo, loadLongMemEval, sampleCases } from "./datasets.js";
import { runBenchmark } from "./driver.js";
import { writeReport } from "./report.js";

/**
 * Tier 3 (ADR-014): LoCoMo and LongMemEval-S through the driver. Retrieval metrics need no model
 * and run whenever the cached dataset exists. Answering is opt-in (YNM_BENCH_ANSWER=1) and bounded
 * (YNM_BENCH_ANSWER_LIMIT, default 20 per dataset) because it spends real tokens.
 */
const answerLimit = Number(process.env.YNM_BENCH_ANSWER_LIMIT ?? 20);
const answering = process.env.YNM_BENCH_ANSWER === "1";
const caseLimit = Number(process.env.YNM_BENCH_CASES ?? 60);

function answerOptions() {
  if (!answering) return undefined;
  const writer = availableWriter();
  const judge = availableJudges().find((j) => j.calibrated) ?? availableJudges()[0];
  if (writer.name === "none" || !judge)
    throw new Error(
      "answering needs a writer and a judge (YNM_EVAL_CLAUDE_CLI=1, YNM_EVAL_CALIBRATED=1)"
    );
  return { writer, judge, limit: answerLimit };
}

describe("tier3 public benchmarks", () => {
  it.skipIf(!existsSync(datasetPath("locomo")))(
    "LoCoMo: evidence recall at k over the ten conversations",
    async () => {
      const ds = loadLocomo();
      const report = await runBenchmark(ds, ds.cases, {
        k: 10,
        answer: answerOptions(),
        onProgress: (m) => console.info(m),
      });
      const file = writeReport(report);
      console.info(
        `LoCoMo evidence recall@10 ${report.retrieval.evidenceRecallAtK} (full ${report.retrieval.fullEvidenceAtK}); ${file}; guard spent ${EVAL_GUARD.spent}`
      );
      expect(report.retrieval.evidenceRecallAtK).toBeGreaterThan(0.3);
    },
    1_800_000
  );

  it.skipIf(!existsSync(datasetPath("longmemeval-s")))(
    "LongMemEval-S: evidence recall at k on a seeded sample of instances",
    async () => {
      const ds = loadLongMemEval();
      const cases = sampleCases(ds.cases, caseLimit, 1);
      const report = await runBenchmark(ds, cases, {
        k: 10,
        answer: answerOptions(),
        onProgress: (m) => console.info(m),
      });
      const file = writeReport(report);
      console.info(
        `LongMemEval-S evidence recall@10 ${report.retrieval.evidenceRecallAtK} (full ${report.retrieval.fullEvidenceAtK}); ${file}; guard spent ${EVAL_GUARD.spent}`
      );
      expect(report.retrieval.evidenceRecallAtK).toBeGreaterThan(0.3);
    },
    3_600_000
  );
});
