import { DEFAULT_REDACTION, IndexManager, Ynm } from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { recordMetric } from "../../baseline.js";
import { generateCorpus } from "../../generator.js";

const SIZE = 2000;

/** recall@k and MRR over the generator's subject queries (ADR-014 tier 1, ADR-005). */
describe("tier1 retrieval quality on the synthetic corpus", () => {
  it("recall@1/5/10 and MRR meet baseline", async () => {
    const log = new MemoryLog("personal", "personal");
    const corpus = generateCorpus({ seed: 11, count: SIZE, namespaces: ["user/eval"] });
    await log.append(corpus.records);
    const ynm = new Ynm({
      mounts: [{ id: "personal", level: "personal", location: "mem", log }],
      actor: "eval",
      userId: "eval",
      redaction: DEFAULT_REDACTION,
      index: new IndexManager("sqlite-fts", { fileFor: () => ":memory:" }),
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });
    const at = { 1: 0, 5: 0, 10: 0 };
    let mrr = 0;
    for (const q of corpus.queries) {
      const hits = await ynm.recall({ text: q.text, limit: 10 });
      const ids = hits.map((h) => h.memoryId);
      const first = ids.findIndex((id) => q.relevant.includes(id));
      if (first >= 0) mrr += 1 / (first + 1);
      for (const k of [1, 5, 10] as const)
        if (ids.slice(0, k).some((id) => q.relevant.includes(id))) at[k] += 1;
    }
    const n = corpus.queries.length;
    expect(n).toBeGreaterThan(10);
    const results = [
      recordMetric({ name: "recall@1", size: SIZE, value: at[1] / n }),
      recordMetric({ name: "recall@5", size: SIZE, value: at[5] / n }),
      recordMetric({ name: "recall@10", size: SIZE, value: at[10] / n }),
      recordMetric({ name: "mrr", size: SIZE, value: mrr / n }),
    ];
    expect(at[10] / n).toBeGreaterThan(0.8);
    expect(
      results.some((r) => r.regressed),
      "retrieval quality regressed vs baseline"
    ).toBe(false);
  }, 120_000);
});
