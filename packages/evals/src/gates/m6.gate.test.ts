/**
 * Milestone gate: M6 v0.1. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos. The release workflow runs it too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBaseline } from "../baseline.js";
import { readReport } from "../tier3/report.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const version = (
  JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** Every number a release freezes; a missing key means the suite that records it was not run. */
const FROZEN_KEYS = [
  "remember@1000",
  "remember@10000",
  "remember@100000",
  "load+fold@100000",
  "sync@1000",
  "reindex@100000",
  "recall@100000",
  "context@100000",
  "remember+index@100000",
  "recall@1@2000",
  "recall@5@2000",
  "recall@10@2000",
  "mrr@2000",
  "dedupe-precision:heuristic@60",
  "dedupe-recall:heuristic@60",
  "contradict-precision:heuristic@60",
  "contradict-recall:heuristic@60",
  "promote-accuracy:heuristic@20",
  "dedupe-precision:typesafe@60",
  "dedupe-recall:typesafe@60",
  "contradict-precision:typesafe@60",
  "contradict-recall:typesafe@60",
  "promote-accuracy:typesafe@20",
  "rerank-lift:typesafe@300",
  "reflect-written-rate:typesafe@2",
  "cleanup-dedupe-precision:typesafe@120",
];

describe("gate M6: v0.1 release", () => {
  it("ADR-014: LoCoMo and LongMemEval-S drivers produce a committed report", () => {
    for (const name of ["locomo", "longmemeval-s"] as const) {
      const r = readReport(version, name);
      expect(r, `report for ${name} ${version} missing; run pnpm bench:public`).toBeDefined();
      if (!r) return;
      expect(r.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.setup.questions).toBeGreaterThan(0);
      expect(r.retrieval.evidenceRecallAtK).toBeGreaterThan(0.3);
      expect(
        r.answering?.n,
        `${name}: answering not recorded (YNM_BENCH_ANSWER=1)`
      ).toBeGreaterThan(0);
      expect(r.setup.judge, "answering must record the judge it used").toBeDefined();
    }
    const unit = spawnSync("pnpm", ["exec", "vitest", "run", "src/tier3/datasets.test.ts"], {
      cwd: join(repoRoot, "packages", "evals"),
      encoding: "utf8",
    });
    expect(unit.status, unit.stdout + unit.stderr).toBe(0);
  }, 300_000);

  it("ADR-014: per-release baselines frozen", () => {
    const file = join(repoRoot, "packages", "evals", "baselines", `${version}.json`);
    expect(existsSync(file), `no baseline file for ${version}`).toBe(true);
    const b = readBaseline() as Record<string, unknown>;
    const missing = FROZEN_KEYS.filter((k) => !(k in b));
    expect(missing, `baseline ${version} is missing keys`).toEqual([]);
    expect(process.env.YNM_BASELINE_VERSION ?? "0.1.0").toBe(version);
  });

  it("ADRs consolidated: addenda folded, status accepted", () => {
    const dir = join(repoRoot, "docs", "adr");
    const files = readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, `${f} not accepted`).toMatch(/^Status: accepted \(\d{4}-\d{2}-\d{2}\)$/m);
      expect(text, `${f} still has an Addenda section`).not.toMatch(/^## Addenda/m);
      expect(text, `${f} still has a draft-era Decided section`).not.toMatch(/^## Decided/m);
    }
  });

  it("Release: the CLI tarball builds, runs, and renders a Homebrew formula", () => {
    const pack = spawnSync("node", [join(repoRoot, "scripts", "release", "pack.mjs"), version], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(pack.status, pack.stdout + pack.stderr).toBe(0);
    const staged = join(repoRoot, "dist-release", `ynm-${version}`);
    const v = spawnSync(join(staged, "ynm"), ["--version"], { encoding: "utf8" });
    expect(v.stdout).toContain(`@ynm/cli/${version}`);
    const serve = spawnSync(join(staged, "ynm"), ["serve", "--help"], { encoding: "utf8" });
    expect(serve.status).toBe(0);
    const sha = readFileSync(
      join(repoRoot, "dist-release", `ynm-${version}.tar.gz.sha256`),
      "utf8"
    ).split(" ")[0] as string;
    const formula = spawnSync(
      "node",
      [join(repoRoot, "scripts", "release", "formula.mjs"), version, sha],
      { encoding: "utf8" }
    );
    expect(formula.status).toBe(0);
    expect(formula.stdout).toContain(`class Ynm < Formula`);
    expect(formula.stdout).toContain(`releases/download/v${version}/ynm-${version}.tar.gz`);
    expect(existsSync(join(repoRoot, ".github", "workflows", "release.yml"))).toBe(true);
  }, 600_000);
});
