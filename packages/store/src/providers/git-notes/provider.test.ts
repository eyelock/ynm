import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ulid } from "@ynm/model";
import { collect, makeRecord, runRecordLogConformance } from "../../testing/conformance.js";
import {
  clone,
  cloneMirror,
  createBare,
  createRepo,
  fx,
  rootCommit,
} from "../../testing/git-fixtures.js";
import { selectAnchor } from "./anchor.js";
import { git, gitStats } from "./git.js";
import { GitNotesLog } from "./provider.js";
import { refFor } from "./refs.js";

const writer = fileURLToPath(new URL("../../../test/fixtures/git-writer.mjs", import.meta.url));

async function personalLog(): Promise<GitNotesLog> {
  const repo = await createRepo(2);
  return new GitNotesLog("p", "personal", { repo, anchor: await rootCommit(repo) });
}

runRecordLogConformance("git-notes", {
  create: async (level) => {
    const repo = await createRepo(2);
    return new GitNotesLog(`git-${level}`, level, { repo, anchor: await rootCommit(repo) });
  },
  corrupt: async (log, record) => {
    const g = log as GitNotesLog;
    const ref = refFor({
      level: record.level,
      namespace: record.namespace,
      type: record.type,
      bucket: record.recordedAt.slice(0, 7),
    });
    await fx(g.repo, "notes", `--ref=${ref}`, "append", "-m", "{broken", g.anchor);
  },
  concurrentWriters: async (log, n, perWriter) => {
    const g = log as GitNotesLog;
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        return new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [writer, g.repo, g.anchor, String(i), String(perWriter)],
            { stdio: ["ignore", "ignore", "pipe"] }
          );
          let err = "";
          child.stderr.on("data", (d) => {
            err += d;
          });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
        });
      })
    );
  },
});

describe("GitNotesLog specifics (ADR-003)", () => {
  it("attaches every shard to the anchor and never touches branches", async () => {
    const log = await personalLog();
    const before = await fx(log.repo, "rev-parse", "HEAD");
    await log.append([makeRecord()]);
    expect(await fx(log.repo, "rev-parse", "HEAD")).toBe(before);
    const refs = await fx(log.repo, "for-each-ref", "--format=%(refname)", "refs/notes/ynm/");
    expect(refs).toMatch(/^refs\/notes\/ynm\/personal\/user\/test\/semantic\/\d{4}-\d{2}$/);
    const listed = await fx(log.repo, "notes", `--ref=${refs}`, "list");
    expect(listed.split(" ")[1]).toBe(log.anchor);
  });

  it("makes the ref history a transaction log with structured messages", async () => {
    const log = await personalLog();
    await log.append([makeRecord()]);
    await log.append([makeRecord(), makeRecord()]);
    const [ref] = (await log.shards()).map((s) => refFor(s));
    const messages = await fx(log.repo, "log", "--format=%s", ref as string);
    expect(messages.split("\n")).toEqual([
      expect.stringMatching(/^ynm: 2 records /),
      expect.stringMatching(/^ynm: 1 record /),
    ]);
  });

  it("retries the compare-and-swap when the ref moves underneath it", async () => {
    const repo = await createRepo(1);
    const anchor = await rootCommit(repo);
    let intruded = false;
    const log = new GitNotesLog("p", "personal", {
      repo,
      anchor,
      beforeUpdateRef: async (ref) => {
        if (intruded) return;
        intruded = true;
        // Another writer lands a record on the same ref via porcelain before our update-ref.
        const other = makeRecord();
        await fx(repo, "notes", `--ref=${ref}`, "append", "-m", JSON.stringify(other), anchor);
      },
    });
    const mine = makeRecord();
    await log.append([mine]);
    const ids = (await collect(log)).map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).toHaveLength(2);
  });

  it("loads any number of shards with two git processes", async () => {
    const log = await personalLog();
    const records = Array.from({ length: 60 }, (_, i) =>
      makeRecord({ namespace: `ns${i % 20}`, recordedAt: `2026-0${1 + (i % 9)}-01T00:00:00.000Z` })
    );
    await log.append(records);
    expect((await log.shards()).length).toBeGreaterThan(40);
    const before = gitStats.spawned;
    expect((await collect(log)).length).toBe(60);
    expect(gitStats.spawned - before).toBe(2);
  });

  it("reads notes written by porcelain, including fanned-out trees", async () => {
    const log = await personalLog();
    const r = makeRecord();
    const ref = refFor({
      level: "personal",
      namespace: r.namespace,
      type: r.type,
      bucket: r.recordedAt.slice(0, 7),
    });
    await fx(log.repo, "notes", `--ref=${ref}`, "add", "-m", JSON.stringify(r), log.anchor);
    expect((await collect(log)).map((x) => x.id)).toEqual([r.id]);
  });

  it("works against a bare repo with no work tree", async () => {
    const bare = await createBare();
    const log = new GitNotesLog("bare", "distributed", {
      repo: bare,
      anchor: await rootCommit(bare),
    });
    const r = makeRecord({ level: "distributed", namespace: "common" });
    await log.append([r]);
    expect((await collect(log)).map((x) => x.id)).toEqual([r.id]);
  });

  it("purge keeps ref history unless asked to forget it", async () => {
    const log = await personalLog();
    const r = makeRecord();
    await log.append([r]);
    await log.append([makeRecord()]);
    const [ref] = (await log.shards()).map((s) => refFor(s));
    expect((await fx(log.repo, "rev-list", "--count", ref as string)).trim()).toBe("2");
    await log.purge(r.memoryId);
    expect((await fx(log.repo, "rev-list", "--count", ref as string)).trim()).toBe("3");
    expect(await fx(log.repo, "log", "--format=%s", "-1", ref as string)).toMatch(/purge/);
    await log.purge((await collect(log))[0]?.memoryId as string, { forgetHistory: true });
    expect((await fx(log.repo, "rev-list", "--count", ref as string)).trim()).toBe("1");
  });

  it("reports health with anchor presence and bad lines", async () => {
    const log = await personalLog();
    const h = await log.health();
    expect(h.ok).toBe(true);
    expect(h.details.anchorPresent).toBe(true);
  });
});

describe("anchor selection (ADR-003)", () => {
  it("picks the oldest root when a repo has several", async () => {
    const repo = await createRepo(1);
    const first = await rootCommit(repo);
    await fx(repo, "checkout", "-q", "--orphan", "other");
    await git(
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "second root",
      ],
      {
        cwd: repo,
        env: {
          GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
          GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
        },
      }
    );
    await fx(repo, "checkout", "-q", "main");
    const sel = await selectAnchor(repo);
    expect(sel).toMatchObject({ sha: first, source: "root-commit", present: true });
  });

  it("never mistakes a notes commit for the root, even in the same second", async () => {
    const repo = await createRepo(1);
    const root = await rootCommit(repo);
    const log = new GitNotesLog("p", "personal", { repo, anchor: root });
    await log.append([makeRecord()]);
    expect(await selectAnchor(repo)).toMatchObject({ sha: root, source: "root-commit" });
    const again = new GitNotesLog("p2", "personal", {
      repo,
      anchor: (await selectAnchor(repo)).sha,
    });
    expect((await collect(again)).length).toBe(1);
  });

  it("honours a configured anchor", async () => {
    const repo = await createRepo(2);
    const head = await fx(repo, "rev-parse", "HEAD");
    expect(await selectAnchor(repo, { configured: head })).toMatchObject({
      sha: head,
      source: "config",
    });
  });

  it("creates a root commit for an empty repo when asked, and refuses otherwise", async () => {
    const repo = await createRepo(0);
    await expect(selectAnchor(repo)).rejects.toThrow(/no commits/);
    const sel = await selectAnchor(repo, {
      create: true,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    expect(sel.source).toBe("created");
    expect(await fx(repo, "rev-parse", "HEAD")).toBe(sel.sha);
  });

  it("refuses to guess on a shallow clone but works with a configured anchor", async () => {
    const source = await createRepo(3);
    const anchor = await rootCommit(source);
    const shallow = await (async () => {
      const dir = await createRepo(0);
      await fx(dir, "remote", "add", "origin", source);
      await fx(dir, "fetch", "-q", "--depth=1", "origin", "main");
      await fx(dir, "checkout", "-q", "-B", "main", "origin/main");
      return dir;
    })();
    await expect(selectAnchor(shallow)).rejects.toThrow(/shallow/);
    const sel = await selectAnchor(shallow, { configured: anchor });
    expect(sel.present).toBe(false);
    const log = new GitNotesLog("s", "personal", { repo: shallow, anchor });
    const r = makeRecord();
    await log.append([r]);
    expect((await collect(log)).map((x) => x.id)).toEqual([r.id]);
  });
});

describe("sync between clones (ADR-003, ADR-007)", () => {
  it("reports a missing remote instead of failing", async () => {
    const repo = await createRepo(1);
    const log = new GitNotesLog("s", "distributed", { repo, anchor: await rootCommit(repo) });
    const r = await log.sync();
    expect(r.conflicts[0]).toMatch(/remote "origin" is not configured/);
  });

  async function pair() {
    const origin = await createBare();
    const anchor = await rootCommit(origin);
    const a = await clone(origin);
    const b = await clone(origin);
    const logA = new GitNotesLog("a", "distributed", { repo: a, anchor });
    const logB = new GitNotesLog("b", "distributed", { repo: b, anchor });
    return { origin, anchor, logA, logB };
  }
  const shared = (over = {}) =>
    makeRecord({
      level: "distributed",
      namespace: "common",
      recordedAt: "2026-09-10T00:00:00.000Z",
      ...over,
    });

  it("syncs a `clone --mirror` store without explicit refspecs", async () => {
    const { origin, anchor, logA } = await pair();
    const ra = shared();
    await logA.append([ra]);
    await logA.sync();
    const mirror = await cloneMirror(origin);
    expect(await fx(mirror, "config", "--get", "remote.origin.mirror")).toBe("true");
    const logM = new GitNotesLog("m", "distributed", { repo: mirror, anchor });
    expect((await collect(logM)).map((r) => r.id)).toEqual([ra.id]);
    const rm = shared();
    await logM.append([rm]);
    const other = await clone(origin);
    await fx(other, "commit", "-q", "--allow-empty", "-m", "moved on");
    await fx(other, "push", "-q", "origin", "HEAD:main");
    const moved = await fx(other, "rev-parse", "HEAD");
    const s = await logM.sync();
    expect(s.conflicts).toEqual([]);
    expect(s.pushed.length).toBeGreaterThan(0);
    // the stale mirror must not rewind a branch that moved on the remote
    expect(await fx(origin, "rev-parse", "main")).toBe(moved);
    await logA.sync();
    expect((await collect(logA)).map((r) => r.id).sort()).toEqual([ra.id, rm.id].sort());
    // a second sync with nothing new is clean
    expect((await logM.sync()).conflicts).toEqual([]);
  });

  it("moves records both ways with zero loss", async () => {
    const { logA, logB } = await pair();
    const ra = shared();
    await logA.append([ra]);
    const s1 = await logA.sync();
    expect(s1.pushed.length).toBe(1);
    const s2 = await logB.sync();
    expect(s2.merged.length).toBe(1);
    expect((await collect(logB)).map((r) => r.id)).toEqual([ra.id]);
    const rb = shared();
    await logB.append([rb]);
    await logB.sync();
    await logA.sync();
    expect((await collect(logA)).map((r) => r.id).sort()).toEqual([ra.id, rb.id].sort());
  });

  it("merges diverged shards with cat_sort_uniq and retries the rejected push", async () => {
    const { logA, logB } = await pair();
    const ra = shared();
    const rb = shared();
    await logA.append([ra]);
    await logB.append([rb]);
    await logA.sync();
    const s = await logB.sync();
    expect(s.conflicts).toEqual([]);
    expect(s.merged.length).toBe(1);
    await logA.sync();
    const idsA = (await collect(logA)).map((r) => r.id).sort();
    const idsB = (await collect(logB)).map((r) => r.id).sort();
    expect(idsA).toEqual([ra.id, rb.id].sort());
    expect(idsB).toEqual(idsA);
  });

  it("never forces the fetch into working refs: an unpushed local record survives a sync", async () => {
    const { logA, logB } = await pair();
    await logA.append([shared()]);
    await logA.sync();
    const local = shared();
    await logB.append([local]);
    await logB.sync({ push: false });
    expect((await collect(logB)).map((r) => r.id)).toContain(local.id);
  });

  it("personal logs are never part of a shared sync", async () => {
    const { origin, anchor } = await pair();
    const a = await clone(origin);
    const personal = new GitNotesLog("p", "personal", { repo: a, anchor });
    await personal.append([makeRecord()]);
    const sharedLog = new GitNotesLog("s", "distributed", { repo: a, anchor });
    await sharedLog.sync();
    const remoteRefs = await fx(origin, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(remoteRefs).not.toMatch(/personal/);
  });

  it("dry run reports without changing anything", async () => {
    const { logA, logB } = await pair();
    await logA.append([shared()]);
    await logA.sync();
    const s = await logB.sync({ dryRun: true });
    expect(s.merged.length).toBe(1);
    expect(await collect(logB)).toEqual([]);
  });

  it("supports a sync with ulid-ordered records across many shards", async () => {
    const { logA, logB } = await pair();
    const recs = Array.from({ length: 30 }, (_, i) =>
      shared({ id: ulid(1_700_000_000_000 + i), type: i % 2 ? "episodic" : "semantic" })
    ).map((r) => ({ ...r, memoryId: r.id }));
    await logA.append(recs);
    await logA.sync();
    await logB.sync();
    expect((await collect(logB)).length).toBe(30);
  });
});
