import { PROMOTE_QUESTIONS } from "@ynm/service";
import { recordMetric } from "../../baseline.js";
import { availableJudges, judgeTag } from "../support.js";

const DURABLE = [
  "Decided: releases are cut from main only after the gate passes.",
  "User prefers British spelling in all docs.",
  "The staging cluster is blue-heron in eu-west-2.",
  "Always run pnpm check before pushing; CI rejects unformatted code.",
  "Team convention: ADRs stay draft until v0.1.",
  "The on-call rota lives in the ops wiki under runbooks.",
  "Postgres connection pool size must stay at 20 in production.",
  "Customer X requires SOC2 evidence for every deploy.",
  "We chose SQLite FTS5 over MiniSearch for the default index.",
  "Do not squash-merge in this repo; notes must survive.",
];
const SCRATCH = [
  "todo: check line 42 of index.ts",
  "currently editing the recall function",
  "next: run the tests again",
  "scratch: temp value was 17",
  "waiting for the build to finish",
  "opened three tabs about zod defaults",
  "remember to come back to this after lunch",
  "half-done refactor of the sync loop",
  "typo fixed in the README, continuing",
  "the test I just ran took 4 seconds",
];

/** Promotion accuracy per judge: durable session notes vs scratch (ADR-006 pass 2). */
describe("tier2 consolidation: promotion decisions per judge", () => {
  for (const judge of availableJudges()) {
    it(`${judge.name}: durable vs scratch accuracy`, async () => {
      let correct = 0;
      let usage = 0;
      for (const [content, durable] of [
        ...DURABLE.map((c) => [c, true] as const),
        ...SCRATCH.map((c) => [c, false] as const),
      ]) {
        const j = await judge.judge(
          { memory: { type: "working", content, summary: content } },
          PROMOTE_QUESTIONS
        );
        usage += j.usage?.inputTokens ?? 0;
        const p = (j.answers.usefulLater as { noul: number }).noul;
        if (p >= 0.5 === durable) correct += 1;
      }
      const acc = correct / (DURABLE.length + SCRATCH.length);
      const r = recordMetric(
        { name: `promote-accuracy:${judgeTag(judge)}`, size: 20, value: acc },
        0.1
      );
      console.info(`${judge.name}: promotion accuracy ${acc.toFixed(2)}, ${usage} input tokens`);
      expect(r.regressed).toBe(false);
      if (judge.calibrated) expect(acc).toBeGreaterThanOrEqual(0.8);
    }, 300_000);
  }
});
