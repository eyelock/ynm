import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { unwrapped, ynm, ynmWith } from "../../test/helpers.js";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function git(dir: string, ...args: string[]): string {
  return spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args],
    {
      encoding: "utf8",
    }
  ).stdout;
}

function repo(): string {
  const dir = temp("ynm-setup-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

/** A directory holding fake client binaries: each prints its argv and exits with `code`. */
function fakeBin(names: string[], code = 0): string {
  const dir = temp("ynm-fakebin-");
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "fake ${name} $*" >> "${dir}/calls.log"\nexit ${code}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** HOME is isolated so detection and user-scope config never touch the real machine. */
const isolated = (path?: string) => ({
  HOME: temp("ynm-user-home-"),
  ...(path ? { PATH: `${path}${delimiter}${process.env.PATH ?? ""}` } : {}),
});

describe("ynm init", () => {
  it("creates, then adopts, a dedicated bare memory repo", () => {
    const bare = join(temp("ynm-bare-"), "memory.git");
    const created = ynm(temp("ynm-cwd-"), "init", "--bare", bare);
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout.trim()).toMatch(
      /^created bare memory repo .*memory\.git \(anchor [0-9a-f]{12}\)$/
    );
    const adopted = JSON.parse(ynm(temp("ynm-cwd-"), "init", "--bare", bare, "--json").stdout) as {
      created: boolean;
    };
    expect(adopted.created).toBe(false);
  });

  it("creates the personal store only", () => {
    const r = ynm(temp("ynm-cwd-"), "init", "--personal");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^personal store (created|ready) at .*store\.git$/);
  });

  it("prints the report: refspecs, hooks, configured clients, commands to run, and others seen", () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", temp("ynm-origin-"));
    const env = isolated(fakeBin(["claude"]));
    const r = ynmWith(dir, { env }, "init", "--client", "ynh", "--client", "opencode");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^initialised /);
    expect(r.stdout).toMatch(/\n {2}anchor {4}[0-9a-f]{40} \(root-commit\)/);
    expect(r.stdout).toMatch(/\n {2}config {4}.*config\.json\n/);
    expect(r.stdout).toMatch(/\n {2}refspecs {2}\S+/);
    expect(r.stdout).toMatch(/\n {2}hooks {5}\S+/);
    expect(r.stdout).toMatch(/\n {2}client {4}opencode: .*opencode\.json/);
    expect(r.stdout).toMatch(/\n {2}run: {6}ynh install /);
    expect(r.stdout).toMatch(/next: `ynm remember/);

    const again = ynmWith(dir, { env }, "init", "--no-clients", "--no-hooks");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/config {4}.*\(unchanged\)/);
    expect(again.stdout).not.toMatch(/client {4}/);

    // Without --client: clients this project uses are configured, others on the machine listed.
    const seen = ynmWith(dir, { env }, "init", "--no-hooks");
    expect(seen.status, seen.stderr).toBe(0);
    expect(seen.stdout).toMatch(/\n {2}client {4}opencode: unchanged/);
    expect(seen.stdout).toMatch(/\n {2}also {6}.*claude-code.*on this machine but not used here/);
  });
});

describe("ynm client", () => {
  it("status lists every client, as text or JSON", () => {
    const dir = temp("ynm-client-");
    const env = isolated();
    const text = ynmWith(dir, { env }, "client", "status");
    expect(text.status, text.stderr).toBe(0);
    for (const c of ["claude-code", "copilot-cli", "opencode", "pi", "ynh"])
      expect(text.stdout).toContain(c);
    const json = JSON.parse(
      ynmWith(dir, { env }, "client", "status", "--json").stdout
    ) as unknown[];
    expect(json.length).toBeGreaterThanOrEqual(5);
  });

  it("with no client named and none configured, says to name one (exit 2)", () => {
    for (const action of ["plan", "install"]) {
      const r = ynmWith(temp("ynm-client-"), { env: isolated() }, "client", action);
      expect(r.status).toBe(2);
      expect(unwrapped(r.stderr)).toMatch(/no agent client is configured in/);
    }
  });

  it("plan shows changes, install applies them, and a second pass says what is in place", () => {
    const dir = temp("ynm-client-");
    const env = isolated();
    const plan = ynmWith(dir, { env }, "client", "plan", "claude-code", "--no-hooks");
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toMatch(/^merge-json .*\.mcp\.json {2}\(register the ynm MCP server/);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    const planJson = JSON.parse(
      ynmWith(dir, { env }, "client", "plan", "claude-code", "--json").stdout
    ) as Array<{ kind: string }>;
    expect(planJson.map((c) => c.kind)).toContain("merge-json");

    const install = ynmWith(dir, { env }, "client", "install", "claude-code", "--no-hooks");
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toMatch(/^merged .*\.mcp\.json: /);
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.ynm).toBeTruthy();

    const replan = ynmWith(dir, { env }, "client", "plan", "claude-code", "--no-hooks");
    expect(replan.stdout).toMatch(/^already in place, nothing changed:\n {2}/);
    const reinstall = ynmWith(
      dir,
      { env },
      "client",
      "install",
      "claude-code",
      "--no-hooks",
      "--json"
    );
    expect(JSON.parse(reinstall.stdout)).toEqual({ client: "claude-code", done: [] });

    // No name: every client this project already uses, each under a heading.
    const one = ynmWith(dir, { env }, "client", "plan", "--no-hooks");
    expect(one.status, one.stderr).toBe(0);
    expect(one.stdout).toMatch(/^claude-code:\nalready in place/);
    expect(ynmWith(dir, { env }, "client", "install", "opencode").status).toBe(0);
    const both = JSON.parse(ynmWith(dir, { env }, "client", "plan", "--json").stdout) as unknown[];
    expect(both).toHaveLength(2);
    const installed = JSON.parse(
      ynmWith(dir, { env }, "client", "install", "--json").stdout
    ) as Array<{ client: string }>;
    expect(installed.map((r) => r.client).sort()).toEqual(["claude-code", "opencode"]);
    const human = ynmWith(dir, { env }, "client", "install");
    expect(human.stdout).toMatch(/^claude-code:$/m);
    expect(human.stdout).toMatch(/^opencode:$/m);
  });

  it("an HTTP transport is written with its URL", () => {
    const dir = temp("ynm-client-");
    const r = ynmWith(
      dir,
      { env: isolated() },
      "client",
      "install",
      "opencode",
      "--http",
      "https://memory.example.com/mcp",
      "--token",
      "t0ken",
      "--json"
    );
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { client: string }).client).toBe("opencode");
    expect(readFileSync(join(dir, "opencode.json"), "utf8")).toContain(
      "https://memory.example.com/mcp"
    );
  });

  it("command changes are shown, or run with --yes, and a failing command fails the install", () => {
    const shown = ynmWith(temp("ynm-client-"), { env: isolated() }, "client", "install", "ynh");
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/^run: ynh install /);

    const ok = fakeBin(["ynh"]);
    const ran = ynmWith(
      temp("ynm-client-"),
      { env: isolated(ok) },
      "client",
      "install",
      "ynh",
      "--yes"
    );
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toMatch(/^ran ynh install /);
    expect(readFileSync(join(ok, "calls.log"), "utf8")).toMatch(/^fake ynh install /);

    const bad = fakeBin(["ynh"], 3);
    const failed = ynmWith(
      temp("ynm-client-"),
      { env: isolated(bad) },
      "client",
      "install",
      "ynh",
      "--yes"
    );
    expect(failed.status).not.toBe(0);
    expect(unwrapped(failed.stderr)).toMatch(/ynh install .* exited 3/);

    const empty = temp("ynm-nobin-");
    const absent = ynmWith(
      temp("ynm-client-"),
      { env: { ...isolated(), PATH: empty } },
      "client",
      "install",
      "ynh",
      "--yes"
    );
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toMatch(/ENOENT/);
  });
});

describe("ynm doctor", () => {
  it("prints each check and exits 0 when nothing fails", () => {
    const r = ynmWith(temp("ynm-doctor-"), { env: isolated() }, "doctor");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^ok {4}git available: /);
    expect(r.stdout).toMatch(/\nok {4}git repository: not inside a git repository/);
  });

  it("marks warnings and failures, and exits 1 on a failure", () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", temp("ynm-origin-"));
    expect(ynm(dir, "init", "--no-hooks", "--no-clients").status).toBe(0);
    git(dir, "update-ref", "refs/notes/ynm/personal/leak", "HEAD");
    const r = ynmWith(dir, { env: isolated() }, "doctor");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\nwarn {2}pre-push hook: not installed/);
    expect(r.stdout).toMatch(
      /\nFAIL {2}no personal refs in project repo: refs\/notes\/ynm\/personal\/leak/
    );
  });
});

describe("ynm validate", () => {
  it("exits 1 when there is nothing to validate", () => {
    const dir = temp("ynm-validate-");
    const r = ynmWith(dir, { env: isolated() }, "validate");
    expect(r.status).toBe(1);
    expect(unwrapped(r.stderr)).toMatch(/nothing to validate in/);
    expect(unwrapped(r.stderr)).toMatch(/no ynh harness and no agent client/);
  });

  it("reports a valid client as JSON and exits 0", () => {
    const dir = temp("ynm-validate-");
    const env = isolated();
    expect(ynmWith(dir, { env }, "client", "install", "claude-code").status).toBe(0);
    const r = ynmWith(dir, { env }, "validate", "--json");
    expect(r.status, r.stdout).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; clients: Array<{ client: string }> };
    expect(out.ok).toBe(true);
    expect(out.clients.map((c) => c.client)).toEqual(["claude-code"]);
    expect(ynmWith(temp("ynm-elsewhere-"), { env }, "validate", dir).stdout).toMatch(
      /^claude-code: valid/
    );
  });
});

describe("ynm status and sync, human output", () => {
  it("status prints the version, config and one line per mount", () => {
    const r = ynm(temp("ynm-status-"), "status");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^ynm \d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/\nconfig: defaults\n/);
    expect(r.stdout).toMatch(/\n {2}personal\s+personal\s+git-notes\s+\d+ shard\(s\)/);
  });

  it("sync with nothing replicating says so; --quiet prints nothing", () => {
    const dir = temp("ynm-sync-");
    expect(ynm(dir, "sync").stdout.trim()).toBe(
      "nothing to sync (no replicating distributed mount)"
    );
    const quiet = ynm(dir, "sync", "--quiet");
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");
  });

  it("sync reports fetched, merged and pushed counts per mount", () => {
    const dir = repo();
    const origin = temp("ynm-origin-");
    git(origin, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", origin);
    expect(ynm(dir, "init", "--no-hooks", "--no-clients").status).toBe(0);
    expect(
      ynm(
        dir,
        "remember",
        "--type",
        "semantic",
        "--level",
        "distributed",
        "--content",
        "shared fact"
      ).status
    ).toBe(0);
    const dry = ynm(dir, "sync", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/^project: fetched \d+, merged \d+, pushed \d+, retries \d+$/m);
    const r = ynm(dir, "sync", "--no-pull");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^project: fetched \d+, merged \d+, pushed [1-9]\d*, retries \d+$/m);
  });

  it("personal sync with an explicit remote reports a missing remote", () => {
    const r = ynm(temp("ynm-sync-"), "sync", "--mount", "personal", "--remote", "backup");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('personal: remote "backup" not configured; nothing to sync');
  });
});
