/**
 * Milestone gate: M1 Log. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryRecordSchema, NamespaceSchema, ulid } from "@ynm/model";
import {
  FsLog,
  fold,
  GitNotesLog,
  gitStats,
  MemoryLog,
  parseJsonl,
  selectAnchor,
} from "@ynm/store";
import { collect, makeRecord } from "@ynm/store/testing";
import { clone, createBare, createRepo, fx, rootCommit } from "@ynm/store/testing/git";
import { BASELINE_FILE, readBaseline } from "../baseline.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");

function ynm(cwd: string, home: string, ...args: string[]) {
  const r = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, YNM_HOME: home, YNM_USER: "gate", YNM_NO_CLAUDE_CLI: "1" },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

async function snapshot(repo: string): Promise<string> {
  const refs = await fx(
    repo,
    "for-each-ref",
    "--format=%(refname)%(objectname)",
    "refs/heads/",
    "refs/tags/"
  );
  const tracked = await fx(repo, "ls-files", "-s");
  return `${refs}\n${tracked}`;
}

function* sourceFiles(dir: string): Iterable<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      yield* sourceFiles(p);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) yield p;
  }
}

describe("gate M1: the log", () => {
  it("ADR-001: store rejects a personal record appended to a distributed log", async () => {
    const log = new MemoryLog("shared", "distributed");
    await expect(log.append([makeRecord({ level: "personal" })])).rejects.toThrow(
      /refusing a personal record/
    );
  });

  it("ADR-001: namespace validation accepts unbounded hierarchical paths and rejects bad segments", () => {
    expect(
      NamespaceSchema.safeParse(Array.from({ length: 30 }, (_, i) => `seg${i}`).join("/")).success
    ).toBe(true);
    for (const bad of ["Upper", "a//b", ".hidden", "a/b/../c", "x.lock", "/a"])
      expect(NamespaceSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("ADR-002: fold over random op sequences (property test) yields supersede-wins, tombstone-hides, snapshot-equivalent state", () => {
    // The property suite itself lives in tier1/semantics; this gate asserts it exists and ran green in this package.
    const prop = join(
      repoRoot,
      "packages",
      "evals",
      "src",
      "tier1",
      "semantics",
      "fold.property.test.ts"
    );
    expect(existsSync(prop)).toBe(true);
    const r = spawnSync("pnpm", ["exec", "vitest", "run", prop], {
      cwd: join(repoRoot, "packages", "evals"),
      encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 180_000);

  it("ADR-002: a corrupt JSONL line is skipped and reported, never fatal", () => {
    const good = makeRecord();
    const { records, problems } = parseJsonl(
      `${JSON.stringify(good)}\n{oops\n${JSON.stringify({ ...good, v: 9 })}\n`
    );
    expect(records.map((r) => r.id)).toEqual([good.id]);
    expect(problems).toHaveLength(2);
  });

  it("ADR-003: anchor selection picks the oldest root commit, honours config override, works on shallow clones and empty repos", async () => {
    const repo = await createRepo(2);
    const root = await rootCommit(repo);
    expect((await selectAnchor(repo)).sha).toBe(root);
    const head = await fx(repo, "rev-parse", "HEAD");
    expect((await selectAnchor(repo, { configured: head })).source).toBe("config");
    const empty = await createRepo(0);
    await expect(selectAnchor(empty)).rejects.toThrow(/no commits/);
    expect(
      (
        await selectAnchor(empty, {
          create: true,
          env: {
            GIT_AUTHOR_NAME: "g",
            GIT_AUTHOR_EMAIL: "g@g",
            GIT_COMMITTER_NAME: "g",
            GIT_COMMITTER_EMAIL: "g@g",
          },
        })
      ).source
    ).toBe("created");
    const shallow = await createRepo(0);
    await fx(shallow, "remote", "add", "origin", repo);
    await fx(shallow, "fetch", "-q", "--depth=1", "origin", "main");
    await expect(selectAnchor(shallow)).rejects.toThrow(/shallow/);
    const sel = await selectAnchor(shallow, { configured: root });
    expect(sel.present).toBe(false);
    const log = new GitNotesLog("s", "personal", { repo: shallow, anchor: root });
    const r = makeRecord();
    await log.append([r]);
    expect((await collect(log)).map((x) => x.id)).toEqual([r.id]);
  });

  it("ADR-003: two clones write independently, sync both ways, zero records lost, shards merge with cat_sort_uniq", async () => {
    const origin = await createBare();
    const anchor = await rootCommit(origin);
    const logA = new GitNotesLog("a", "distributed", { repo: await clone(origin), anchor });
    const logB = new GitNotesLog("b", "distributed", { repo: await clone(origin), anchor });
    const mk = () =>
      makeRecord({
        level: "distributed",
        namespace: "common",
        recordedAt: "2026-09-05T00:00:00.000Z",
      });
    const ra = [mk(), mk()];
    const rb = [mk(), mk(), mk()];
    await logA.append(ra);
    await logB.append(rb);
    await logA.sync();
    const s = await logB.sync();
    expect(s.conflicts).toEqual([]);
    await logA.sync();
    const want = [...ra, ...rb].map((r) => r.id).sort();
    expect((await collect(logA)).map((r) => r.id).sort()).toEqual(want);
    expect((await collect(logB)).map((r) => r.id).sort()).toEqual(want);
  });

  it("ADR-003: N concurrent local writers on one shard lose zero records (lock plus update-ref CAS)", async () => {
    const repo = await createRepo(1);
    const anchor = await rootCommit(repo);
    const writer = join(repoRoot, "packages", "store", "test", "fixtures", "git-writer.mjs");
    await Promise.all(
      Array.from(
        { length: 5 },
        (_, i) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [writer, repo, anchor, String(i), "12"], {
              stdio: ["ignore", "ignore", "pipe"],
            });
            let err = "";
            child.stderr.on("data", (d) => {
              err += d;
            });
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
          })
      )
    );
    const log = new GitNotesLog("p", "personal", { repo, anchor });
    expect((await collect(log)).length).toBe(60);
  }, 180_000);

  it("ADR-003: full load uses batched plumbing (two git processes for 1000 shards, not N)", async () => {
    const repo = await createRepo(1);
    const log = new GitNotesLog("p", "personal", { repo, anchor: await rootCommit(repo) });
    const records = Array.from({ length: 1000 }, (_, i) =>
      makeRecord({
        namespace: `ns${Math.floor(i / 4)}`,
        type: (["semantic", "episodic", "procedural", "reference"] as const)[i % 4],
        recordedAt: "2026-09-01T00:00:00.000Z",
      })
    );
    await log.append(records);
    expect((await log.shards()).length).toBe(1000);
    const before = gitStats.spawned;
    expect((await collect(log)).length).toBe(1000);
    expect(gitStats.spawned - before).toBe(2);
  }, 600_000);

  it("ADR-004: conformance suite passes on memory, fs and git-notes providers", () => {
    const r = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=verbose", "src/providers"], {
      cwd: join(repoRoot, "packages", "store"),
      encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/conformance: memory/);
    expect(r.stdout + r.stderr).toMatch(/conformance: fs/);
    expect(r.stdout + r.stderr).toMatch(/conformance: git-notes/);
  }, 300_000);

  it("ADR-004: nothing above store imports a provider (dependency rule test)", () => {
    const offenders: string[] = [];
    for (const pkg of ["index", "service", "mcp", "cli", "wiki", "evals"]) {
      for (const file of sourceFiles(join(repoRoot, "packages", pkg, "src"))) {
        const text = readFileSync(file, "utf8");
        if (/from\s+["']@ynm\/store\/(providers|dist)/.test(text)) offenders.push(file);
        if (
          pkg !== "service" &&
          /\b(GitNotesLog|FsLog|MemoryLog)\b/.test(text) &&
          !file.includes("gates") &&
          !/tier[123]/.test(file)
        )
          offenders.push(file);
        if (
          pkg === "service" &&
          /\b(GitNotesLog|FsLog|MemoryLog)\b/.test(text) &&
          !file.endsWith("mounts.ts")
        )
          offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ADR-007: init never writes personal refs or personal push refspecs into a project repo", async () => {
    const origin = await createBare();
    const repo = await createRepo(1);
    await fx(repo, "remote", "add", "origin", origin);
    const home = join(await createRepo(0), ".ynm");
    expect(ynm(repo, home, "init").status).toBe(0);
    expect(ynm(repo, home, "remember", "--type", "semantic", "--content", "private").status).toBe(
      0
    );
    expect(
      ynm(
        repo,
        home,
        "remember",
        "--type",
        "semantic",
        "--level",
        "distributed",
        "--content",
        "shared"
      ).status
    ).toBe(0);
    const projectRefs = await fx(repo, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(projectRefs).not.toMatch(/personal/);
    // init adds no push refspec at all (the hook pushes), so this key may be absent
    const pushes = await fx(repo, "config", "--get-all", "remote.origin.push").catch(() => "");
    const fetches = await fx(repo, "config", "--get-all", "remote.origin.fetch");
    expect(`${pushes}\n${fetches}`).not.toMatch(/personal/);
    expect(
      await fx(join(home, "store.git"), "for-each-ref", "--format=%(refname)", "refs/notes/")
    ).toMatch(/ynm\/personal\/user\/gate/);
  });

  it("ADR-007: promote creates a new shared record with a derives-from link and leaves the personal original untouched", async () => {
    const repo = await createRepo(1);
    const home = join(await createRepo(0), ".ynm");
    ynm(repo, home, "init", "--no-hooks");
    const { memoryId } = JSON.parse(
      ynm(repo, home, "remember", "--type", "procedural", "--content", "always gate", "--json")
        .stdout
    ) as { memoryId: string };
    const promoted = JSON.parse(ynm(repo, home, "promote", memoryId, "--json").stdout) as {
      memoryId: string;
      mount: string;
    };
    expect(promoted.mount).toBe("project");
    const list = JSON.parse(ynm(repo, home, "list", "--json").stdout) as Array<{
      memoryId: string;
      mount: string;
      links: Array<{ rel: string; to: string }>;
    }>;
    expect(list.find((m) => m.memoryId === memoryId)?.mount).toBe("personal");
    expect(list.find((m) => m.memoryId === promoted.memoryId)?.links).toEqual([
      { rel: "derives-from", to: memoryId },
    ]);
  });

  it("ADR-009: init on a repo with history changes no branch, tag or tracked file", async () => {
    const repo = await createRepo(4);
    await fx(repo, "tag", "v0");
    const before = await snapshot(repo);
    const home = join(await createRepo(0), ".ynm");
    expect(ynm(repo, home, "init").status).toBe(0);
    expect(await snapshot(repo)).toBe(before);
    expect(existsSync(join(repo, ".ynm", "config.json"))).toBe(true);
    expect(statSync(join(repo, ".ynm", "config.json")).size).toBeGreaterThan(0);
    expect(MemoryRecordSchema).toBeTruthy();
    expect(ulid()).toHaveLength(26);
  });

  it("ADR-014: latency baselines for remember, load and sync recorded at 1k, 10k, 100k", () => {
    expect(
      existsSync(BASELINE_FILE),
      `missing ${BASELINE_FILE}; run YNM_WRITE_BASELINE=1 YNM_BENCH_LARGE=1 pnpm --filter @ynm/evals bench`
    ).toBe(true);
    const b = readBaseline();
    for (const key of [
      "remember@1000",
      "remember@10000",
      "remember@100000",
      "load+fold@1000",
      "load+fold@10000",
      "load+fold@100000",
      "sync@1000",
    ]) {
      expect(b[key], key).toBeDefined();
      expect(b[key]?.p95Ms).toBeGreaterThan(0);
    }
    expect(fold([]).memories.size).toBe(0);
    expect(FsLog).toBeTruthy();
  });
});
