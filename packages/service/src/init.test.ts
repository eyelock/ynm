import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createBare, createRepo, fx, rootCommit } from "@ynm/store/testing/git";
import { doctor } from "./doctor.js";
import { initBare, initProject } from "./init.js";
import { openYnm } from "./open.js";
import { ensurePersonalStore } from "./personal-store.js";

/**
 * Client detection that sees nothing from the machine running the tests: an empty PATH and an
 * empty home, so whether opencode, copilot or claude is installed here cannot change a result.
 * A test that needs a client passes its own home, PATH or project files.
 */
function isolated(home = mkdtempSync(join(tmpdir(), "ynm-nohome-"))) {
  return { home, env: { PATH: "" } };
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
    const report = await initProject({ cwd: repo, env, clients: isolated() });
    expect(await snapshot(repo)).toBe(before);
    expect(report.anchor).toBe(await rootCommit(repo));
    expect(report.anchorSource).toBe("root-commit");
    expect(JSON.parse(readFileSync(report.configFile, "utf8"))).toEqual({ anchor: report.anchor });
    const fetch = await fx(repo, "config", "--get-all", "remote.origin.fetch");
    expect(fetch).toContain(
      "+refs/notes/ynm/distributed/*:refs/notes/ynm-remote/origin/distributed/*"
    );
    expect(fetch).not.toMatch(/personal/);
    const push = await fx(repo, "config", "--get-all", "remote.origin.push").catch(() => "");
    expect(push).toBe("");
    expect(report.hooksInstalled).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(true);
    const again = await initProject({ cwd: repo, env, clients: isolated() });
    expect(again.configWritten).toBe(false);
    expect(again.refspecs).toEqual([]);
    expect(again.notes).toEqual([]);
  });

  it("excludes the local wiki and index directories via .git/info/exclude, never a tracked file", async () => {
    const repo = await createRepo(1);
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    const exclude = join(repo, ".git", "info", "exclude");
    const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const report = await initProject({ cwd: repo, hooks: false, clients: isolated() });
    expect(report.notes).toContain("added .ynm/ to .git/info/exclude");
    expect(readFileSync(exclude, "utf8")).toBe(
      `${before}${before.endsWith("\n") || before === "" ? "" : "\n"}.ynm/\n`
    );
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n");
    const second = await initProject({ cwd: repo, hooks: false, clients: isolated() });
    expect(second.notes.filter((n) => n.includes("exclude"))).toEqual([]);
    expect(readFileSync(exclude, "utf8").match(/^\.ynm\/$/gm)).toHaveLength(1);
  });

  it("takes the hook default from the hooks config key; the flag wins", async () => {
    const home = await createRepo(0);
    mkdirSync(join(home, ".ynm"), { recursive: true });
    writeFileSync(join(home, ".ynm", "config.json"), JSON.stringify({ hooks: false }));
    const env = { YNM_HOME: join(home, ".ynm") };
    const off = await createRepo(1);
    expect((await initProject({ cwd: off, env, clients: isolated() })).hooksInstalled).toEqual([]);
    expect(existsSync(join(off, ".git", "hooks", "pre-push"))).toBe(false);
    const on = await createRepo(1);
    expect(
      (await initProject({ cwd: on, env, hooks: true, clients: isolated() })).hooksInstalled
    ).toHaveLength(1);
  });

  it("creates the root commit in an empty repo", async () => {
    const repo = await createRepo(0);
    const report = await initProject({ cwd: repo, clients: isolated() });
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
    await initProject({ cwd: repo, hooks: false, clients: isolated() });
    const env = { YNM_HOME: join(home, ".ynm"), YNM_USER: "david" };
    const { ynm, mounts } = await openYnm({ cwd: repo, env });
    expect(mounts.map((m) => m.id)).toEqual(["personal", "project"]);
    await ynm.remember({ type: "semantic", content: "personal fact" });
    await ynm.remember({ type: "semantic", level: "distributed", content: "distributed fact" });
    const projectRefs = await fx(repo, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(projectRefs).toMatch(/refs\/notes\/ynm\/distributed\/common\/semantic/);
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
    await initProject({ cwd: repo, hooks: false, clients: isolated() });
    const pushes = await fx(repo, "config", "--get-all", "remote.origin.push").catch(() => "");
    expect(pushes).toBe("");
    const env = { YNM_HOME: join(home, ".ynm") };
    const ctx = await openYnm({ cwd: repo, env });
    const checks = (await doctor({ ...ctx, clients: { ...isolated(), cwd: repo } })).checks.map(
      (c) => c.name
    );
    expect(checks).not.toContain("distributed push refspec");
    await ctx.ynm.remember({ type: "semantic", level: "distributed", content: "distributed fact" });
    await ctx.ynm.sync();
    await fx(repo, "commit", "--allow-empty", "-m", "x");
    await fx(repo, "push", "origin", "HEAD:refs/heads/topic");
    const remoteRefs = await fx(origin, "for-each-ref", "--format=%(refname)", "refs/notes/");
    expect(remoteRefs).toMatch(/refs\/notes\/ynm\/distributed\/common\/semantic/);
  });

  it("doctor is clean after init and warns before", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    const origin = await createBare();
    await fx(repo, "remote", "add", "origin", origin);
    const env = { YNM_HOME: join(home, ".ynm") };
    let ctx = await openYnm({ cwd: repo, env });
    let report = await doctor({ ...ctx, clients: { ...isolated(), cwd: repo } });
    expect(report.checks.find((c) => c.name === "project initialised")?.ok).toBe(false);
    await initProject({ cwd: repo, clients: isolated() });
    ctx = await openYnm({ cwd: repo, env });
    report = await doctor({ ...ctx, clients: { ...isolated(), cwd: repo } });
    expect(report.ok).toBe(true);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("configures the clients it detects, only inside the work tree, idempotently", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    mkdirSync(join(repo, ".claude"));
    const clients = { home, env: { PATH: "" } };
    const first = await initProject({ cwd: repo, hooks: false, clients });
    // No .mcp.json and no CLAUDE.md block: the server is a `claude mcp add --scope local` line
    // (not run here, since no runner is given) and guidance comes from the SessionStart hook.
    expect(first.clients).toMatchObject([
      {
        client: "claude-code",
        detected: ".claude",
        applied: ["3 hooks"],
        run: ["claude mcp add --scope local ynm -- ynm serve"],
        left: [],
      },
    ]);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(false);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    // hooks land in the personal project settings, never the team's tracked settings.json
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
    const again = await initProject({ cwd: repo, hooks: false, clients });
    expect(again.clients).toMatchObject([
      {
        client: "claude-code",
        detected: ".claude",
        applied: [],
        run: ["claude mcp add --scope local ynm -- ynm serve"],
      },
    ]);
    expect(
      again.clients[0]?.files.map((f) => relative(realpathSync(repo), realpathSync(f)))
    ).toEqual([join(".claude", "settings.local.json")]);
    const none = await initProject({ cwd: await createRepo(1), hooks: false, clients });
    expect(none.clients).toEqual([]);
    const bare = (await initBare(join(await createRepo(0), "m.git"))).repo;
    writeFileSync(join(bare, ".mcp.json"), "{}");
    expect((await initProject({ cwd: bare, hooks: false, clients })).clients).toEqual([]);
  });

  it("runs the client's local-scope command in the project when given a runner", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    mkdirSync(join(repo, ".claude"));
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    const runCommand = async (argv: string[], cwd: string) => {
      calls.push({ argv, cwd });
    };
    const r = await initProject({
      cwd: repo,
      hooks: false,
      clients: { home, env: { PATH: "" }, runCommand },
    });
    expect(calls).toEqual([
      {
        argv: ["claude", "mcp", "add", "--scope", "local", "ynm", "--", "ynm", "serve"],
        cwd: realpathSync(repo),
      },
    ]);
    expect(r.clients[0]?.run).toEqual([]);
    expect(r.clients[0]?.applied).toContain("claude mcp add --scope local");
    // a runner that fails leaves the command as a line to run by hand
    const failing = await initProject({
      cwd: repo,
      hooks: false,
      clients: {
        home,
        env: { PATH: "" },
        runCommand: async () => {
          throw new Error("claude not found");
        },
      },
    });
    expect(failing.clients[0]?.run).toEqual(["claude mcp add --scope local ynm -- ynm serve"]);
  });

  it("leaves git status exactly as it was, with a tracked CLAUDE.md, opencode.json and AGENTS.md (ynm #37)", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "CLAUDE.md"), "# team rules\n");
    writeFileSync(join(repo, "opencode.json"), `${JSON.stringify({ theme: "x" }, null, 2)}\n`);
    writeFileSync(join(repo, "AGENTS.md"), "# agents\n");
    await fx(repo, "add", "-A");
    await fx(repo, "commit", "-q", "-m", "team setup");
    const before = await fx(repo, "status", "--porcelain");
    const tracked = ["AGENTS.md", "opencode.json", join(".claude", "CLAUDE.md")].map((f) => [
      f,
      readFileSync(join(repo, f), "utf8"),
    ]);
    const report = await initProject({
      cwd: repo,
      hooks: false,
      clients: { home, env: { PATH: "" }, only: ["claude-code", "opencode"] },
    });
    expect(await fx(repo, "status", "--porcelain")).toBe(before);
    for (const [f, text] of tracked)
      expect(readFileSync(join(repo, f as string), "utf8")).toBe(text);
    expect(report.clients.find((c) => c.client === "opencode")?.left.sort()).toEqual([
      "AGENTS.md",
      "opencode.json",
    ]);
    expect(report.commit).toEqual([]);
  });

  it("hides a client file it creates, so the tree is not left dirty (ynm #37)", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    const before = await fx(repo, "status", "--porcelain");
    await initProject({
      cwd: repo,
      hooks: false,
      clients: { home, env: { PATH: "" }, only: ["opencode"] },
    });
    expect(existsSync(join(repo, "opencode.json"))).toBe(true);
    expect(await fx(repo, "status", "--porcelain")).toBe(before);
  });

  it("detects from PATH, home and project, and never applies changes outside the work tree", async () => {
    const home = await createRepo(0);
    const bin = await createRepo(0);
    writeFileSync(join(bin, "copilot"), "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const repo = await createRepo(1);
    const r = await initProject({ cwd: repo, hooks: false, clients: { home, env: { PATH: bin } } });
    // Installed on the machine but not used by this project: suggested, never written.
    expect(r.clients).toMatchObject([
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
    mkdirSync(join(repo, ".agents", "harness"), { recursive: true });
    writeFileSync(
      join(repo, ".agents", "harness", "plugin.json"),
      JSON.stringify({ name: "h", version: "0.1.0" })
    );
    const clients = { home, env: { PATH: "" } };
    const manifest = readFileSync(join(repo, ".agents", "harness", "plugin.json"), "utf8");
    const r = await initProject({ cwd: repo, hooks: false, clients });
    expect(r.clients).toEqual([]);
    expect(readFileSync(join(repo, ".agents", "harness", "plugin.json"), "utf8")).toBe(manifest);
    expect(existsSync(join(repo, "skills"))).toBe(false);
    const forced = await initProject({
      cwd: repo,
      hooks: false,
      clients: { ...clients, only: ["opencode"] },
    });
    expect(forced.clients).toMatchObject([
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
    mkdirSync(join(harness, ".agents", "harness"), { recursive: true });
    writeFileSync(
      join(harness, ".agents", "harness", "plugin.json"),
      JSON.stringify({ name: "h" })
    );
    await expect(initProject({ cwd: harness, clients: isolated() })).rejects.toThrow(
      /ynh harness, not a project.*ynm client install ynh/
    );
  });

  it("says which files to commit and which stay local, and keeps the local ones out of git", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { ynm: {} } }));
    const clients = { home, env: { PATH: "" } };
    const report = await initProject({ cwd: repo, hooks: false, clients });
    // the user's own untracked .mcp.json is the only thing to commit; init added nothing to it
    expect(report.commit).toEqual([".mcp.json"]);
    expect(report.local).toEqual([".claude/settings.local.json"]);
    const untracked = await fx(repo, "status", "--porcelain");
    expect(untracked).not.toContain("settings.local.json");
    expect(untracked).not.toContain(".ynm");
    await fx(repo, "add", "-A");
    await fx(repo, "commit", "-q", "-m", "ynm");
    const again = await initProject({ cwd: repo, hooks: false, clients });
    expect(again.commit).toEqual([]);
  });

  it("excludes personal files in this clone even when a global ignore file already covers them", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    mkdirSync(join(repo, ".claude"));
    const globalIgnore = join(await createRepo(0), "global-ignore");
    writeFileSync(globalIgnore, ".claude/settings.local.json\n");
    await fx(repo, "config", "core.excludesFile", globalIgnore);
    await initProject({ cwd: repo, hooks: false, clients: { home, env: { PATH: "" } } });
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".claude/settings.local.json");
    // a second run does not repeat the line
    await initProject({ cwd: repo, hooks: false, clients: { home, env: { PATH: "" } } });
    const again = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(again.split("\n").filter((l) => l === ".claude/settings.local.json")).toHaveLength(1);
  });

  it("with no remote yet, sync later adds the fetch refspec itself; nothing to push is not a failure", async () => {
    const repo = await createRepo(1);
    const env = { YNM_HOME: join(await createRepo(0), ".ynm") };
    const report = await initProject({ cwd: repo, env, hooks: false, clients: isolated() });
    expect(report.refspecs).toEqual([]);
    expect(report.notes.join("\n")).toContain("`ynm sync`");
    expect(report.notes.join("\n")).not.toContain("re-run init");
    const origin = await createBare();
    await fx(repo, "remote", "add", "origin", origin);
    const { ynm } = await openYnm({ cwd: repo, env });
    const first = (await ynm.sync()).project;
    expect(first?.conflicts).toEqual([]);
    expect(first?.refspecAdded).toBe(
      "+refs/notes/ynm/distributed/*:refs/notes/ynm-remote/origin/distributed/*"
    );
    await ynm.remember({ type: "semantic", level: "distributed", content: "distributed fact" });
    const second = (await ynm.sync()).project;
    expect(second?.refspecAdded).toBeUndefined();
    expect(second?.pushed.length).toBe(1);
  });

  it("doctor warns about a client with the server but no guidance or hooks", async () => {
    const home = await createRepo(0);
    const repo = await createRepo(1);
    await initProject({ cwd: repo, hooks: false, clients: isolated() });
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { ynm: { command: "ynm", args: ["serve"] } } })
    );
    const ctx = await openYnm({ cwd: repo, env: { YNM_HOME: join(home, ".ynm") } });
    const report = await doctor({ ...ctx, clients: { cwd: repo, home, env: { PATH: "" } } });
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
