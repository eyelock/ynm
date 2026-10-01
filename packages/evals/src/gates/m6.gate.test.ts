/**
 * Milestone gate: M6 v0.1. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos. The release workflow runs it too.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    expect(process.env.YNM_BASELINE_VERSION ?? version).toBe(version);
  });

  it("ADRs consolidated: addenda folded, status accepted", () => {
    const dir = join(repoRoot, "docs", "adr");
    const files = readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(15);
    // The records the v0.1 release shipped with (000 to 016) are accepted; a later record may be
    // proposed while it is discussed, but never carries draft-era sections.
    const RELEASED = 16;
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      const status =
        Number(f.slice(0, 3)) <= RELEASED
          ? /^Status: accepted \(\d{4}-\d{2}-\d{2}\)$/m
          : /^Status: (accepted|proposed) \(\d{4}-\d{2}-\d{2}\)$/m;
      expect(text, `${f} not accepted`).toMatch(status);
      expect(text, `${f} still has an Addenda section`).not.toMatch(/^## Addenda/m);
      expect(text, `${f} still has a draft-era Decided section`).not.toMatch(/^## Decided/m);
    }
  });

  it("Release: the slim tarball and the native standalone binary build, run, and render both formulae", () => {
    const script = (name: string) => join(repoRoot, "scripts", "release", name);
    const node = (name: string, ...args: string[]) =>
      spawnSync("node", [script(name), ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    const out = join(repoRoot, "dist-release");
    // Start clean, keeping downloaded Node tarballs (dist-release/node).
    for (const f of existsSync(out) ? readdirSync(out) : [])
      if (f !== "node") rmSync(join(out, f), { recursive: true, force: true });

    // Slim: the ESM bundle and its launcher, run on this Node.
    const slim = node("build-slim.mjs", version);
    expect(slim.status, slim.stdout + slim.stderr).toBe(0);
    const unpacked = mkdtempSync(join(tmpdir(), "ynm-slim-"));
    const untar = spawnSync("tar", [
      "-xzf",
      join(out, `ynm_${version}_slim.tar.gz`),
      "-C",
      unpacked,
    ]);
    expect(untar.status).toBe(0);
    const smokeSlim = node("smoke.mjs", version, join(unpacked, "bin", "ynm"));
    expect(smokeSlim.status, smokeSlim.stdout + smokeSlim.stderr).toBe(0);

    // Standalone: this platform's binary (the others are built on their own runners).
    const os = process.platform as "darwin" | "linux";
    const arch = process.arch === "x64" ? "amd64" : (process.arch as "arm64");
    expect(["darwin", "linux"]).toContain(os);
    const tarball = node("fetch-node.mjs", "--os", os, "--arch", arch);
    expect(tarball.status, tarball.stderr).toBe(0);
    const standalone = node(
      "build-standalone.mjs",
      "--os",
      os,
      "--arch",
      arch,
      "--node-tarball",
      tarball.stdout.trim(),
      "--version",
      version
    );
    expect(standalone.status, standalone.stdout + standalone.stderr).toBe(0);
    const smokeBin = node("smoke.mjs", version, join(out, `ynm_${version}_${os}_${arch}`, "ynm"));
    expect(smokeBin.status, smokeBin.stdout + smokeBin.stderr).toBe(0);

    // Manifest and formulae. The standalone formula needs all four targets; the ones not built
    // here get placeholder entries so the rendering is still exercised.
    const manifest = node("manifest.mjs", version);
    expect(manifest.status, manifest.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      version: string;
      assets: Array<{ file: string; kind: string; os: string; arch: string; sha256: string }>;
    };
    expect(m.assets.map((a) => a.file).sort()).toEqual(
      [`ynm_${version}_${os}_${arch}.tar.gz`, `ynm_${version}_slim.tar.gz`].sort()
    );
    for (const o of ["darwin", "linux"])
      for (const a of ["arm64", "amd64"])
        if (!m.assets.some((x) => x.os === o && x.arch === a))
          m.assets.push({
            file: `ynm_${version}_${o}_${a}.tar.gz`,
            kind: "standalone",
            os: o,
            arch: a,
            sha256: "0".repeat(64),
          });
    const full = join(unpacked, "manifest.json");
    writeFileSync(full, JSON.stringify(m));
    const ynmRb = node("formula.mjs", full, "ynm");
    expect(ynmRb.status, ynmRb.stderr).toBe(0);
    expect(ynmRb.stdout).toContain("class Ynm < Formula");
    expect(ynmRb.stdout).toContain(
      `releases/download/v${version}/ynm_${version}_${os}_${arch}.tar.gz`
    );
    expect(ynmRb.stdout).not.toContain('depends_on "node"');
    const slimRb = node("formula.mjs", full, "ynm-slim");
    expect(slimRb.status, slimRb.stderr).toBe(0);
    expect(slimRb.stdout).toContain("class YnmSlim < Formula");
    expect(slimRb.stdout).toContain(`releases/download/v${version}/ynm_${version}_slim.tar.gz`);
    expect(slimRb.stdout).toContain('depends_on "node"');
    rmSync(unpacked, { recursive: true, force: true });
    expect(existsSync(join(repoRoot, ".github", "workflows", "release.yml"))).toBe(true);
  }, 900_000);
});
