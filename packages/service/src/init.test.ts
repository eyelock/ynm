import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const env = { YNM_HOME: join(await createRepo(0), ".ynm") };
    const report = await initProject({ cwd: repo, env });
    expect(await snapshot(repo)).toBe(before);
    expect(report.anchor).toBe(await rootCommit(repo));
    expect(report.anchorSource).toBe("root-commit");
    expect(JSON.parse(readFileSync(report.configFile, "utf8"))).toEqual({ anchor: report.anchor });
    const fetch = await fx(repo, "config", "--get-all", "remote.origin.fetch");
    expect(fetch).toContain("+refs/notes/ynm/shared/*:refs/notes/ynm-remote/origin/shared/*");
    expect(fetch).not.toMatch(/personal/);
    const push = await fx(repo, "config", "--get-all", "remote.origin.push").catch(() => "");
    expect(push).toBe("");
    expect(report.hooksInstalled).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(true);
    const again = await initProject({ cwd: repo, env });
    expect(again.configWritten).toBe(false);
    expect(again.refspecs).toEqual([]);
    expect(again.notes).toEqual([]);
  });

  it("excludes the local wiki and index directories via .git/info/exclude, never a tracked file", async () => {
    const repo = await createRepo(1);
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    const exclude = join(repo, ".git", "info", "exclude");
    const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const report = await initProject({ cwd: repo, hooks: false });
    expect(report.notes).toContain("added .ynm/wiki/ and .ynm/index/ to .git/info/exclude");
    expect(readFileSync(exclude, "utf8")).toBe(
      `${before}${before.endsWith("\n") || before === "" ? "" : "\n"}.ynm/wiki/\n.ynm/index/\n`
    );
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n");
    const second = await initProject({ cwd: repo, hooks: false });
    expect(second.notes.filter((n) => n.includes("exclude"))).toEqual([]);
    expect(readFileSync(exclude, "utf8").match(/\.ynm\/wiki\//g)).toHaveLength(1);
  });

  it("takes the hook default from the hooks config key; the flag wins", async () => {
    const home = await createRepo(0);
    mkdirSync(join(home, ".ynm"), { recursive: true });
    writeFileSync(join(home, ".ynm", "config.json"), JSON.stringify({ hooks: false }));
    const env = { YNM_HOME: join(home, ".ynm") };
    const off = await createRepo(1);
    expect((await initProject({ cwd: off, env })).hooksInstalled).toEqual([]);
    expect(existsSync(join(off, ".git", "hooks", "pre-push"))).toBe(false);
    const on = await createRepo(1);
    expect((await initProject({ cwd: on, env, hooks: true })).hooksInstalled).toHaveLength(1);
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

  it("writes no notes push refspec, so a plain push after sync exits 0", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    const origin = await createBare();
    await fx(repo, "remote", "add", "origin", origin);
    await initProject({ cwd: repo, hooks: false });
    const pushes = await fx(repo, "config", "--get-all", "remote.origin.push").catch(() => "");
    expect(pushes).toBe("");
    const env = { YNM_HOME: join(home, ".ynm") };
    const ctx = await openYnm({ cwd: repo, env });
    const checks = (await doctor(ctx)).checks.map((c) => c.name);
    expect(checks).not.toContain("shared push refspec");
    await ctx.ynm.remember({ type: "semantic", level: "distributed", content: "shared fact" });
    await ctx.ynm.sync();
    await fx(repo, "commit", "--allow-empty", "-m", "x");
    await fx(repo, "push", "origin", "HEAD:refs/heads/topic");
    const remoteRefs = await fx(origin, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(remoteRefs).toMatch(/refs\/notes\/ynm\/shared\/common\/semantic/);
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

  it("configures the clients it detects, only inside the work tree, idempotently", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    const clients = { home, env: { PATH: "" } };
    const first = await initProject({ cwd: repo, hooks: false, clients });
    expect(first.clients).toEqual([
      {
        client: "claude-code",
        detected: ".mcp.json",
        applied: [".mcp.json", "CLAUDE.md", "3 hooks"],
        run: [],
      },
    ]);
    // hooks land in the personal project settings, never the team's tracked settings.json
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
    const again = await initProject({ cwd: repo, hooks: false, clients });
    expect(again.clients).toEqual([
      { client: "claude-code", detected: ".mcp.json", applied: [], run: [] },
    ]);
    const none = await initProject({ cwd: await createRepo(1), hooks: false, clients });
    expect(none.clients).toEqual([]);
    const bare = (await initBare(join(await createRepo(0), "m.git"))).repo;
    writeFileSync(join(bare, ".mcp.json"), "{}");
    expect((await initProject({ cwd: bare, hooks: false, clients })).clients).toEqual([]);
  });

  it("detects from PATH, home and project, and never applies changes outside the work tree", async () => {
    const home = await createRepo(0);
    const bin = await createRepo(0);
    writeFileSync(join(bin, "copilot"), "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const repo = await createRepo(1);
    const r = await initProject({ cwd: repo, hooks: false, clients: { home, env: { PATH: bin } } });
    // Installed on the machine but not used by this project: suggested, never written.
    expect(r.clients).toEqual([
      {
        client: "copilot-cli",
        detected: "copilot on PATH",
        applied: [],
        run: ["ynm client install copilot-cli"],
        skipped: "machine-only",
      },
      {
        client: "pi",
        detected: "~/.pi/agent",
        applied: [],
        run: ["ynm client install pi"],
        skipped: "machine-only",
      },
    ]);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(repo, ".pi"))).toBe(false);
    expect(existsSync(join(home, ".copilot"))).toBe(false);
  });

  it("never installs into a ynh harness on its own, and --client forces an undetected client", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    mkdirSync(join(repo, ".ynh-plugin"));
    writeFileSync(
      join(repo, ".ynh-plugin", "plugin.json"),
      JSON.stringify({ name: "h", version: "0.1.0" })
    );
    const clients = { home, env: { PATH: "" } };
    const manifest = readFileSync(join(repo, ".ynh-plugin", "plugin.json"), "utf8");
    const r = await initProject({ cwd: repo, hooks: false, clients });
    expect(r.clients).toEqual([]);
    expect(readFileSync(join(repo, ".ynh-plugin", "plugin.json"), "utf8")).toBe(manifest);
    expect(existsSync(join(repo, "skills"))).toBe(false);
    const forced = await initProject({
      cwd: repo,
      hooks: false,
      clients: { ...clients, only: ["opencode"] },
    });
    expect(forced.clients).toEqual([
      {
        client: "opencode",
        detected: "requested",
        applied: ["opencode.json", "AGENTS.md"],
        run: [],
      },
    ]);
  });

  it("refuses a ynh harness directory with a pointer to the harness install", async () => {
    const dir = await createRepo(0);
    const harness = join(dir, "..", `harness-${Date.now()}`);
    mkdirSync(join(harness, ".ynh-plugin"), { recursive: true });
    writeFileSync(join(harness, ".ynh-plugin", "plugin.json"), JSON.stringify({ name: "h" }));
    await expect(initProject({ cwd: harness })).rejects.toThrow(
      /ynh harness, not a project.*ynm client install ynh/
    );
  });

  it("doctor warns about a client with the server but no guidance or hooks", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    await initProject({ cwd: repo, hooks: false });
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { ynm: { command: "ynm", args: ["serve"] } } })
    );
    const ctx = await openYnm({ cwd: repo, env: { YNM_HOME: join(home, ".ynm") } });
    const report = await doctor({ ...ctx, clients: { cwd: repo, home } });
    expect(report.checks.find((c) => c.name === "client claude-code")).toEqual({
      name: "client claude-code",
      ok: false,
      level: "warn",
      detail: "guidance and hooks missing; run `ynm client install claude-code`",
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "client opencode")).toBeUndefined();
  });
});
