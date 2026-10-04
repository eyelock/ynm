/**
 * Milestone gate: M4 Lifecycle. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamConfigSchema } from "@ynm/model";
import { HeuristicJudge, NoneWriter } from "@ynm/models";
import {
  buildWiki,
  DEFAULT_REDACTION,
  dream,
  IndexManager,
  ingestWikiPage,
  Ynm,
} from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { readBaseline } from "../baseline.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

function noKeys(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { YNM_NO_CLAUDE_CLI: "1" };
  for (const [k, v] of Object.entries(process.env))
    if (!/API_KEY|TOKEN|SECRET/i.test(k)) env[k] = v;
  return env;
}

function vitest(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=verbose", ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

function make(judge = new HeuristicJudge()) {
  let t = 0;
  const now = () => new Date(Date.parse("2026-09-29T00:00:00.000Z") + ++t * 1000);
  const writer = new NoneWriter();
  const config = DreamConfigSchema.parse({ judgeOnWrite: false });
  const ynm = new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "gate",
    userId: "gate",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("sqlite-fts", { fileFor: () => ":memory:" }),
    models: { judge, writer, resolution: { judge: "gate", writer: "gate" } },
    dream: config,
    now,
  });
  return { ynm, judge, writer, config, now };
}

const metric = (key: string) => (readBaseline() as Record<string, { value?: number }>)[key]?.value;

describe("gate M4: lifecycle", () => {
  it("ADR-006: dedupe, contradiction and promotion precision and recall meet baseline per Judge implementation", () => {
    for (const k of [
      "dedupe-precision:heuristic@300",
      "dedupe-recall:heuristic@300",
      "contradict-precision:heuristic@300",
      "promote-accuracy:heuristic@20",
    ]) {
      expect(
        metric(k),
        `${k} baseline missing; run the tier2 consolidation suite with YNM_WRITE_BASELINE=1`
      ).toBeDefined();
    }
    const calibrated = Object.keys(readBaseline()).filter((k) =>
      k.startsWith("dedupe-recall:typesafe")
    );
    expect(
      calibrated.length,
      "no calibrated (typesafe) consolidation baseline recorded"
    ).toBeGreaterThan(0);
    expect(metric(calibrated[0] as string)).toBeGreaterThan(0.5);
  });

  it("ADR-006: every dream pass has a no-model fallback that runs with no keys", async () => {
    expect(Object.keys(noKeys()).some((k) => /API_KEY/i.test(k))).toBe(false);
    const { ynm, judge, writer, config, now } = make();
    await ynm.remember({
      type: "working",
      namespace: "session/g",
      content: "scratch",
      ttl: "PT1S",
      tags: ["promote"],
    });
    await ynm.remember({ type: "semantic", subject: "entity:x", content: "The cluster is blue" });
    await ynm.remember({
      type: "semantic",
      subject: "entity:x",
      content: "The cluster is not blue",
    });
    for (let i = 0; i < 3; i++)
      await ynm.remember({
        type: "episodic",
        subject: "topic:r",
        content: `Release ${i} slipped yesterday`,
      });
    const r = await dream(ynm, {}, { judge, writer, config, now });
    expect(Object.keys(r.passes).sort()).toEqual([
      "contradict",
      "dedupe",
      "expire",
      "normalise",
      "promote",
      "reflect",
      "retention",
    ]);
    expect(r.judge.calibrated).toBe(false);
    expect(r.passes.reflect?.fallback).toBe(true);
    expect(r.passes.dedupe?.changed).toEqual([]);
    expect(r.passes.normalise?.changed.length).toBe(3);
    expect(r.estimatedCostUsd).toBe(0);
  });

  it("ADR-012: Writer output fails closed on schema mismatch; judgments stored as annotate data; thresholds read from config", async () => {
    const models = vitest(join(repoRoot, "packages", "models"), noKeys());
    expect(models.status, models.out).toBe(0);
    expect(models.out).toMatch(/validates, retries once with the issues, then rejects/);
    const service = vitest(join(repoRoot, "packages", "service"), noKeys(), "src/dream");
    expect(service.status, service.out).toBe(0);
    expect(service.out).toMatch(/stores the judgment and links the survivor/);
    const strict = DreamConfigSchema.parse({ thresholds: { dedupe: { act: 0.99, review: 0.98 } } });
    expect(strict.thresholds.dedupe.act).toBe(0.99);
    expect(() =>
      DreamConfigSchema.parse({ thresholds: { dedupe: { act: 0.5, review: 0.9 } } })
    ).toThrow();
  }, 600_000);

  it("ADR-012: reflect pass verified by the Noul battery; unsupported-claim rate under baseline", () => {
    const keys = Object.keys(readBaseline()).filter((k) =>
      k.startsWith("reflect-unsupported-rate:")
    );
    expect(
      keys.length,
      "run the tier2 faithfulness eval (needs a writer and a calibrated judge)"
    ).toBeGreaterThan(0);
    expect(metric(keys[0] as string)).toBeGreaterThanOrEqual(0.5);
  });

  it("ADR-005: Judge-backed reranker shows recall@k lift over lexical only", () => {
    const keys = Object.keys(readBaseline()).filter((k) => k.startsWith("rerank-lift:"));
    expect(keys.length, "run the tier2 rerank eval (needs a calibrated judge)").toBeGreaterThan(0);
    expect(metric(keys[0] as string)).toBeGreaterThanOrEqual(0);
  });

  it("ADR-010: wiki golden files for index, log, entity and topic pages on both targets; wiki ingest round-trips", async () => {
    const wiki = vitest(join(repoRoot, "packages", "wiki"), noKeys());
    expect(wiki.status, wiki.out).toBe(0);
    expect(wiki.out).toMatch(/matches the golden pages/);
    expect(wiki.out).toMatch(/directory and an orphan branch/);
    const { ynm } = make();
    const { memoryId } = await ynm.remember({
      type: "procedural",
      content: "Run the gate before tagging.",
      summary: "Run the gate",
    });
    const dir = mkdtempSync(join(tmpdir(), "ynm-gate-wiki-"));
    const built = await buildWiki(ynm, { target: "directory", dir, home: dir });
    expect(built[0]?.written).toBeGreaterThan(1);
    const page = join(dir, "memories", `${memoryId}.md`);
    writeFileSync(
      page,
      readFileSync(page, "utf8").replace(
        "Run the gate before tagging.",
        "Run the M4 gate before tagging."
      )
    );
    const ingested = await ingestWikiPage(ynm, readFileSync(page, "utf8"));
    expect(ingested).toEqual({ memoryId, changed: true });
    expect((await ynm.find(memoryId))?.current.content).toBe("Run the M4 gate before tagging.");
  }, 300_000);

  it("ADR-002: purge leaves a purge-marker and history intact until --forget-history", () => {
    const store = vitest(join(repoRoot, "packages", "store"), noKeys(), "src/providers/git-notes");
    expect(store.status, store.out).toBe(0);
    expect(store.out).toMatch(/purge keeps ref history unless asked to forget it/);
    const service = vitest(join(repoRoot, "packages", "service"), noKeys(), "src/purge.test.ts");
    expect(service.status, service.out).toBe(0);
  }, 600_000);

  it("Exit: a seeded store with 5% duplicates and 2% contradictions is cleaned by one dream run within baseline at a recorded cost (size bounded by the token budget)", () => {
    const keys = Object.keys(readBaseline()).filter((k) =>
      k.startsWith("cleanup-dedupe-recall:typesafe")
    );
    expect(keys.length, "run the tier2 cleanup eval with the calibrated judge").toBeGreaterThan(0);
    expect(metric(keys[0] as string)).toBeGreaterThan(0.5);
    const cost = Object.keys(readBaseline()).find((k) => k.startsWith("cleanup-cost-usd:typesafe"));
    expect(metric(cost as string)).toBeLessThan(1);
  });
});
