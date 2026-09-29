import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REDACTION, IndexManager, Ynm } from "@ynm/service";
import { GitNotesLog } from "@ynm/store";
import { createRepo, rootCommit } from "@ynm/store/testing/git";
import { REGRESSION_LIMIT, record, time } from "../../baseline.js";
import { generateCorpus } from "../../generator.js";

const SIZES = process.env.YNM_BENCH_LARGE === "1" ? [10_000, 100_000] : [10_000];

async function seededYnm(size: number): Promise<Ynm> {
  const repo = await createRepo(1);
  const log = new GitNotesLog("personal", "personal", { repo, anchor: await rootCommit(repo) });
  const { records } = generateCorpus({ seed: 5, count: size, namespaces: ["user/bench"] });
  for (let i = 0; i < records.length; i += 5000) await log.append(records.slice(i, i + 5000));
  const dir = mkdtempSync(join(tmpdir(), "ynm-ix-bench-"));
  return new Ynm({
    mounts: [{ id: "personal", level: "personal", location: repo, log }],
    actor: "bench",
    userId: "bench",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("sqlite-fts", { fileFor: () => join(dir, "personal.sqlite") }),
  });
}

function guard(name: string, ratio?: number): void {
  if (ratio !== undefined)
    expect(ratio, `${name} regressed x${ratio.toFixed(2)}`).toBeLessThan(REGRESSION_LIMIT);
}

describe("tier1 latency: recall, context, reindex (ADR-014, NFR-2)", () => {
  for (const size of SIZES) {
    it(`rebuild, recall and context at ${size}`, async () => {
      const ynm = await seededYnm(size);
      const rebuild = await time("reindex", size, 1, async () => {
        await ynm.reindex();
      });
      guard("reindex", record(rebuild).ratio);
      const queries = [
        "anchor root commit",
        "release deploy",
        "sqlite index recall",
        "session agent",
        "merge sync clone",
      ];
      let i = 0;
      const recall = await time("recall", size, 20, async () => {
        const hits = await ynm.recall({ text: queries[i++ % queries.length], limit: 10 });
        expect(hits.length).toBeGreaterThan(0);
      });
      guard("recall", record(recall).ratio);
      const ctx = await time("context", size, 10, async () => {
        await ynm.context({ budgetTokens: 1500 });
      });
      guard("context", record(ctx).ratio);
      const write = await time("remember+index", size, 10, async () => {
        await ynm.remember({ type: "semantic", content: `bench write ${i++}` });
      });
      guard("remember+index", record(write).ratio);
    }, 900_000);
  }
});
