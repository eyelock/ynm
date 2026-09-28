import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createBare, createRepo, fx, rootCommit } from "@ynm/store/testing/git";
import { doctor } from "./doctor.js";
import { initBare, initProject } from "./init.js";
import { openYnm } from "./open.js";
import { ensurePersonalStore } from "./personal-store.js";

async function snapshot(repo: string): Promise<string> {
  const refs = await fx(
    repo,
    "for-each-ref",
    "--format=%(refname)%(objectname)",
    "refs/heads/",
    "refs/tags/"
  );
  const tracked = await fx(repo, "ls-files", "-s");
  const status = await fx(repo, "status", "--porcelain", "--untracked-files=no");
  return `${refs}\n${tracked}\n${status}`;
}

describe("ynm init (ADR-009 retrofit)", () => {
  it("changes no branch, tag or tracked file, writes config, refspecs and a hook", async () => {
    const origin = await createBare();
    const repo = await createRepo(3);
    await fx(repo, "remote", "add", "origin", origin);
    await fx(repo, "tag", "v1");
    const before = await snapshot(repo);
    const report = await initProject({ cwd: repo });
    expect(await snapshot(repo)).toBe(before);
    expect(report.anchor).toBe(await rootCommit(repo));
    expect(report.anchorSource).toBe("root-commit");
    expect(JSON.parse(readFileSync(report.configFile, "utf8"))).toEqual({ anchor: report.anchor });
    const fetch = await fx(repo, "config", "--get-all", "remote.origin.fetch");
    expect(fetch).toContain("+refs/notes/ynm/shared/*:refs/notes/ynm-remote/origin/shared/*");
    expect(fetch).not.toMatch(/personal/);
    const push = await fx(repo, "config", "--get-all", "remote.origin.push");
    expect(push).toContain("refs/notes/ynm/shared/*:refs/notes/ynm/shared/*");
    expect(push).not.toMatch(/personal/);
    expect(report.hooksInstalled).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(true);
    const again = await initProject({ cwd: repo });
    expect(again.configWritten).toBe(false);
    expect(again.refspecs).toEqual([]);
  });

  it("creates the root commit in an empty repo", async () => {
    const repo = await createRepo(0);
    const report = await initProject({ cwd: repo });
    expect(report.anchorSource).toBe("created");
    expect(await fx(repo, "rev-parse", "HEAD")).toBe(report.anchor);
  });

  it("initBare creates a dedicated memory repo with one root commit", async () => {
    const path = join(await createRepo(0), "memory.git");
    const r = await initBare(path);
    expect(r.created).toBe(true);
    expect(await rootCommit(path)).toBe(r.anchor);
    expect((await initBare(path)).created).toBe(false);
  });

  it("personal store is created on first use, outside any project", async () => {
    const home = await createRepo(0);
    const store = await ensurePersonalStore(join(home, ".ynm", "store.git"));
    expect(store.created).toBe(true);
    expect((await ensurePersonalStore(store.repo)).created).toBe(false);
  });
});

describe("openYnm end to end on git notes", () => {
  it("remembers personal and project memories and keeps them apart", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(2);
    await initProject({ cwd: repo, hooks: false });
    const env = { YNM_HOME: join(home, ".ynm"), YNM_USER: "david" };
    const { ynm, mounts } = await openYnm({ cwd: repo, env });
    expect(mounts.map((m) => m.id)).toEqual(["personal", "project"]);
    await ynm.remember({ type: "semantic", content: "personal fact" });
    await ynm.remember({ type: "semantic", level: "distributed", content: "shared fact" });
    const projectRefs = await fx(repo, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(projectRefs).toMatch(/refs\/notes\/ynm\/shared\/common\/semantic/);
    expect(projectRefs).not.toMatch(/personal/);
    const personalRefs = await fx(
      join(home, ".ynm", "store.git"),
      "for-each-ref",
      "--format=%(refname)",
      "refs/notes/"
    );
    expect(personalRefs).toMatch(/refs\/notes\/ynm\/personal\/user\/david\/semantic/);
    const all = await ynm.list();
    expect(all.map((m) => m.mount).sort()).toEqual(["personal", "project"]);
  });

  it("doctor is clean after init and warns before", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    const origin = await createBare();
    await fx(repo, "remote", "add", "origin", origin);
    const env = { YNM_HOME: join(home, ".ynm") };
    let ctx = await openYnm({ cwd: repo, env });
    let report = await doctor(ctx);
    expect(report.checks.find((c) => c.name === "project initialised")?.ok).toBe(false);
    await initProject({ cwd: repo });
    ctx = await openYnm({ cwd: repo, env });
    report = await doctor(ctx);
    expect(report.ok).toBe(true);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
