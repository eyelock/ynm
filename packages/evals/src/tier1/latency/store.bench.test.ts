import type { MemoryRecord } from "@ynm/model";
import { fold, GitNotesLog } from "@ynm/store";
import { clone, createBare, createRepo, rootCommit } from "@ynm/store/testing/git";
import { REGRESSION_LIMIT, record, time } from "../../baseline.js";
import { generateCorpus } from "../../generator.js";

const SIZES = process.env.YNM_BENCH_LARGE === "1" ? [1_000, 10_000, 100_000] : [1_000, 10_000];

async function seeded(
  size: number,
  level: "personal" | "distributed" = "personal"
): Promise<{ log: GitNotesLog; records: MemoryRecord[] }> {
  const repo = await createRepo(1);
  const log = new GitNotesLog("bench", level, { repo, anchor: await rootCommit(repo) });
  const { records } = generateCorpus({
    seed: 1,
    count: size,
    level,
    namespaces: level === "personal" ? ["user/bench"] : ["common"],
  });
  for (let i = 0; i < records.length; i += 2000) await log.append(records.slice(i, i + 2000));
  return { log, records };
}

function assertNoGrossRegression(name: string, ratio?: number): void {
  if (ratio !== undefined)
    expect(ratio, `${name} regressed x${ratio.toFixed(2)} vs baseline`).toBeLessThan(
      REGRESSION_LIMIT
    );
}

describe("tier1 latency: git-notes store (ADR-014, NFR-2, NFR-3)", () => {
  for (const size of SIZES) {
    it(`remember (single append) into a store of ${size}`, async () => {
      const { log } = await seeded(size);
      const extra = generateCorpus({ seed: 2, count: 30, namespaces: ["user/bench"] }).records;
      let i = 0;
      const t = await time("remember", size, 20, async () => {
        await log.append([extra[i++ % extra.length] as MemoryRecord]);
      });
      assertNoGrossRegression("remember", record(t).ratio);
    }, 300_000);

    it(`cold load and fold of ${size}`, async () => {
      const { log } = await seeded(size);
      const t = await time("load+fold", size, 5, async () => {
        const all: MemoryRecord[] = [];
        for await (const r of log.scan()) all.push(r);
        expect(fold(all).memories.size).toBeGreaterThan(0);
      });
      assertNoGrossRegression("load+fold", record(t).ratio);
    }, 300_000);
  }

  it("sync of a store against a local bare remote", async () => {
    const origin = await createBare();
    const anchor = await rootCommit(origin);
    const a = await clone(origin);
    const logA = new GitNotesLog("a", "distributed", { repo: a, anchor });
    const { records } = generateCorpus({
      seed: 3,
      count: 1_000,
      level: "distributed",
      namespaces: ["common"],
    });
    await logA.append(records);
    const t = await time("sync", 1_000, 5, async () => {
      await logA.append(
        [
          {
            ...(records[0] as MemoryRecord),
            id: `${Date.now()}`.padStart(26, "0").replace(/^0/, "7").slice(0, 26),
          } as MemoryRecord,
        ].map((r) => ({ ...r, memoryId: r.id }))
      );
      await logA.sync();
    });
    assertNoGrossRegression("sync", record(t).ratio);
  }, 300_000);
});
