import { recordMetric } from "../../baseline.js";
import { availableJudges, judgeTag, seeded } from "../support.js";

const SIZE = 300;
const QUERIES = 10;

/** Judge-backed reranker lift over lexical-only recall (ADR-005), cost-capped by query count. */
describe("tier2 rerank: judge-backed rerank vs lexical only", () => {
  for (const judge of availableJudges().filter((j) => j.calibrated)) {
    it(`${judge.name}: recall@5 lift`, async () => {
      const { ynm, corpus } = await seeded({ seed: 9, count: SIZE }, judge, {
        name: "none",
        write: async () => {
          throw new Error("none");
        },
      });
      const queries = corpus.queries
        .slice(0, QUERIES)
        .map((q) => ({ text: q.text.replace(/-\d+$/, ""), relevant: q.relevant }));
      const at5 = async (rerank: boolean) => {
        let hits = 0;
        for (const q of queries) {
          const r = await ynm.recall({ text: q.text, limit: 5, rerank });
          if (r.some((h) => q.relevant.includes(h.memoryId))) hits += 1;
        }
        return hits / queries.length;
      };
      const lexical = await at5(false);
      const reranked = await at5(true);
      console.info(
        `${judge.name}: recall@5 lexical ${lexical.toFixed(2)} -> reranked ${reranked.toFixed(2)} on ${queries.length} ambiguous queries`
      );
      recordMetric(
        { name: `rerank-lift:${judgeTag(judge)}`, size: SIZE, value: reranked - lexical },
        0.1
      );
      recordMetric({ name: `rerank-recall5:${judgeTag(judge)}`, size: SIZE, value: reranked }, 0.1);
      expect(reranked).toBeGreaterThanOrEqual(lexical - 0.04);
    }, 900_000);
  }
});
