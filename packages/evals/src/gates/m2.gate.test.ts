/**
 * Milestone gate: M2 Recall. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REDACTION, IndexManager, Ynm } from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { readBaseline } from "../baseline.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const evals = join(repoRoot, "packages", "evals");

function noKeys(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/API_KEY|TOKEN|SECRET/i.test(k)) env[k] = v;
  return env;
}

const clock = { t: 0, frozen: false };

function make(): Ynm {
  clock.t = 0;
  clock.frozen = false;
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "gate",
    userId: "gate",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("sqlite-fts", { fileFor: () => ":memory:" }),
    now: () => {
      if (!clock.frozen) clock.t += 1;
      return new Date(Date.parse("2026-09-29T00:00:00.000Z") + clock.t * 1000);
    },
  });
}

describe("gate M2: recall", () => {
  it("ADR-005: recall@10 on the synthetic corpus meets baseline per type and namespace", () => {
    const b = readBaseline() as Record<string, { value?: number }>;
    expect(
      b["recall@10@2000"]?.value,
      "baseline missing; run YNM_WRITE_BASELINE=1 on the retrieval suite"
    ).toBeGreaterThan(0.8);
    const r = spawnSync("pnpm", ["exec", "vitest", "run", "src/tier1/retrieval"], {
      cwd: evals,
      encoding: "utf8",
      env: noKeys(),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 300_000);

  it("ADR-005: index conformance suite passes on sqlite-fts and memory indexes", () => {
    const r = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=verbose"], {
      cwd: join(repoRoot, "packages", "index"),
      encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/conformance: sqlite-fts/);
    expect(r.stdout + r.stderr).toMatch(/conformance: memory/);
  }, 300_000);

  it("ADR-005: reindex from the log reproduces identical hits", async () => {
    const y = make();
    for (let i = 0; i < 50; i++)
      await y.remember({
        type: i % 2 ? "semantic" : "episodic",
        content: `note ${i} about ${i % 3 ? "anchors" : "shards"}`,
        tags: [i % 2 ? "a" : "b"],
      });
    clock.frozen = true;
    const before = (await y.recall({ text: "shards anchors", limit: 25, explain: true })).map(
      (h) => [h.memoryId, (h.explain?.relevance ?? 0).toFixed(6)]
    );
    await y.reindex();
    const after = (await y.recall({ text: "shards anchors", limit: 25, explain: true })).map(
      (h) => [h.memoryId, (h.explain?.relevance ?? 0).toFixed(6)]
    );
    expect(after).toEqual(before);
  });

  it("ADR-005: p95 recall and context under budget at 100k on the reference machine", () => {
    const b = readBaseline() as Record<string, { p95Ms?: number }>;
    expect(
      b["recall@100000"]?.p95Ms,
      "run YNM_WRITE_BASELINE=1 YNM_BENCH_LARGE=1 on the latency suite"
    ).toBeDefined();
    expect(b["recall@100000"]?.p95Ms).toBeLessThan(200);
    expect(b["context@100000"]?.p95Ms).toBeLessThan(200);
    expect(b["remember+index@100000"]?.p95Ms).toBeLessThan(150);
  });

  it("ADR-002: data string values are searchable and keys filterable", async () => {
    const y = make();
    await y.remember({
      type: "semantic",
      content: "profile",
      data: { role: "platform engineer" },
      dataSchema: "user-profile/1",
    });
    await y.remember({ type: "semantic", content: "other" });
    expect((await y.recall({ text: "platform engineer" })).length).toBe(1);
    expect((await y.recall({ dataKey: "role" })).length).toBe(1);
    expect((await y.recall({ dataKey: "missing" })).length).toBe(0);
  });

  it("NFR-13: the whole M2 suite runs with no API keys in the environment", () => {
    const env = noKeys();
    expect(Object.keys(env).some((k) => /API_KEY/i.test(k))).toBe(false);
    for (const pkg of ["index", "service"]) {
      const r = spawnSync("pnpm", ["exec", "vitest", "run"], {
        cwd: join(repoRoot, "packages", pkg),
        encoding: "utf8",
        env,
      });
      expect(r.status, `${pkg}: ${r.stdout + r.stderr}`).toBe(0);
    }
    expect(existsSync(join(repoRoot, "packages", "index", "dist", "sqlite-index.js"))).toBe(true);
  }, 600_000);
});
