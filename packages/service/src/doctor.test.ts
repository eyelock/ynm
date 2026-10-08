import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryLog, type RecordLog } from "@ynm/store";
import { createRepo, fx, tempDir } from "@ynm/store/testing/git";
import { applyChanges, clientAdapter } from "./clients/index.js";
import { YnmConfigSchema } from "./config.js";
import { type Check, type DoctorReport, doctor } from "./doctor.js";
import type { Mount } from "./mounts.js";
import type { WorktreeInfo } from "./worktree.js";

function worktree(path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    isGitRepo: true,
    isWorktree: false,
    isBare: false,
    mainRepoPath: path,
    currentPath: path,
    gitCommonDir: join(path, ".git"),
    gitDir: join(path, ".git"),
    ...over,
  };
}

function loaded(home: string) {
  return { config: YnmConfigSchema.parse({ provider: "memory" }), files: [], home };
}

/** A log whose health report is fixed, to drive doctor's mount checks. */
function stubMount(
  id: string,
  provider: string,
  health: { ok: boolean; problems: string[]; details: Record<string, unknown> }
): Mount {
  const log = Object.assign(new MemoryLog(id, "personal"), {
    provider,
    health: async () => health,
  }) as unknown as RecordLog;
  return { id, level: "personal", log, location: `/stores/${id}` };
}

const check = (r: DoctorReport, name: string): Check | undefined =>
  r.checks.find((c) => c.name === name);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("doctor", () => {
  it("reports unhealthy mounts as errors and a missing anchor object as a warning", async () => {
    const home = tempDir("ynm-doc-");
    const report = await doctor({
      loaded: loaded(home),
      worktree: worktree(home, { isGitRepo: false }),
      mounts: [
        stubMount("broken", "fs", { ok: false, problems: ["unreadable", "torn"], details: {} }),
        stubMount("shallow", "git-notes", {
          ok: true,
          problems: [],
          details: { anchorPresent: false },
        }),
      ],
    });
    expect(check(report, "mount broken (fs)")).toEqual({
      name: "mount broken (fs)",
      ok: false,
      level: "error",
      detail: "unreadable; torn",
    });
    expect(check(report, "mount shallow anchor object")?.level).toBe("warn");
    expect(check(report, "git repository")?.detail).toMatch(/not inside a git repository/);
    expect(check(report, "config files")?.detail).toBe("none (defaults)");
    expect(report.ok).toBe(false);
  });

  it("reports whether each remote mount is signed in, without going online", async () => {
    const home = tempDir("ynm-doc-");
    const url = "https://memory.example.com/mcp";
    const config = YnmConfigSchema.parse({
      provider: "memory",
      mounts: [{ id: "team", level: "distributed", provider: "mcp", url }],
    });
    const base = {
      loaded: { config, files: [], home },
      worktree: worktree(home, { isBare: true }),
      mounts: [],
    };
    expect(check(await doctor(base), "mount team (mcp)")).toMatchObject({
      ok: false,
      level: "warn",
    });
    expect(check(await doctor(base), "mount team (mcp)")?.detail).toMatch(/run `ynm login team`/);
    mkdirSync(join(home, "auth"), { recursive: true });
    writeFileSync(
      join(home, "auth", "team.json"),
      JSON.stringify({ url, tokens: { access_token: "a", token_type: "Bearer" } })
    );
    expect(check(await doctor(base), "mount team (mcp)")).toMatchObject({
      ok: true,
      detail: `${url}, signed in`,
    });
  });

  it("warns in a ynh worker that has no YNM_HOME", async () => {
    const home = tempDir("ynm-doc-");
    const run = () =>
      doctor({ loaded: loaded(home), worktree: worktree(home, { isGitRepo: false }), mounts: [] });
    vi.stubEnv("YNM_HOME", "");
    vi.stubEnv("YNH_AGENT_SESSION", "");
    expect(check(await run(), "ynh worker environment")).toBeUndefined();
    vi.stubEnv("YNH_AGENT_SESSION", "s1");
    const c = check(await run(), "ynh worker environment");
    expect(c?.level).toBe("warn");
    expect(c?.detail).toMatch(/env_passthrough.*ynm client install ynh.*ynh update ynm/);
    vi.stubEnv("YNM_HOME", "/elsewhere");
    expect(check(await run(), "ynh worker environment")).toBeUndefined();
  });

  it("warns when a local launcher exists but its directory is not on PATH", async () => {
    const home = tempDir("ynm-doc-");
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ynm"), "#!/bin/sh\n");
    const base = { loaded: loaded(home), worktree: worktree(home, { isBare: true }), mounts: [] };
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const off = check(await doctor(base), "local install on PATH");
    expect(off).toMatchObject({ ok: false, level: "warn" });
    expect(off?.detail).toMatch(/not on PATH/);
    vi.stubEnv("PATH", `/usr/bin:${bin}:/bin`);
    expect(check(await doctor(base), "local install on PATH")).toMatchObject({
      ok: true,
      level: "info",
      detail: bin,
    });
  });

  it("flags a missing anchor, a missing fetch refspec, personal refspecs and personal refs", async () => {
    const repo = await createRepo(1);
    const origin = await createRepo(0);
    mkdirSync(join(repo, ".ynm"));
    writeFileSync(join(repo, ".ynm", "config.json"), "{}");
    await fx(repo, "remote", "add", "origin", origin);
    await fx(repo, "config", "--add", "remote.origin.push", "refs/notes/ynm/personal/*");
    await fx(repo, "update-ref", "refs/notes/ynm/personal/leak", "HEAD");
    const report = await doctor({
      loaded: loaded(tempDir("ynm-doc-")),
      worktree: worktree(repo),
      mounts: [],
    });
    expect(check(report, "project anchor configured")).toMatchObject({
      ok: false,
      detail: "missing anchor in .ynm/config.json",
    });
    expect(check(report, "distributed fetch refspec")).toMatchObject({
      ok: false,
      detail: "missing; `ynm sync` adds it",
    });
    expect(check(report, "personal refs never pushed")?.ok).toBe(false);
    expect(check(report, "no personal refs in project repo")).toMatchObject({
      ok: false,
      detail: "refs/notes/ynm/personal/leak",
    });
    expect(check(report, "pre-push hook")).toMatchObject({ ok: false, detail: "not installed" });
    expect(report.ok).toBe(false);
  });

  it("reports configured clients with and without hooks as healthy", async () => {
    const home = tempDir("ynm-doc-home-");
    const repo = tempDir("ynm-doc-proj-");
    const target = {
      cwd: repo,
      home,
      scope: "project" as const,
      transport: { kind: "stdio" as const, command: "ynm", args: ["serve"] },
    };
    for (const name of ["claude-code", "opencode"])
      await applyChanges(await clientAdapter(name).plan(target));
    const report = await doctor({
      loaded: loaded(home),
      worktree: worktree(repo, { isGitRepo: false }),
      mounts: [],
      clients: { cwd: repo, home },
    });
    expect(check(report, "client claude-code")?.detail).toMatch(
      /^server, guidance and hooks in place/
    );
    expect(check(report, "client opencode")?.detail).toMatch(/^server and guidance in place/);
    expect(check(report, "client claude-code")?.ok).toBe(true);
  });
});
