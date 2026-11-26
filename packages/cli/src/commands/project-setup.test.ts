import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { ynmWith } from "../../test/helpers.js";

/**
 * The supported project setup for Claude Code (ynm #195, docs/how-to/set-up-a-project-for-claude-code.md):
 * `ynm init --no-clients`, then `ynm client install claude-code` once, committing what it writes.
 * It must change nothing outside the project (no `claude mcp add`, nothing under the home
 * directory or ynm's own home), and a fresh clone must read the first clone's distributed memory.
 */

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function git(dir: string, ...args: string[]) {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args],
    { encoding: "utf8" }
  );
  expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/** Every file under `dir` with its content, keyed by relative path; `skip` names top-level entries to ignore. */
function snapshot(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (d === dir && skip.includes(name)) continue;
      if (statSync(p).isDirectory()) {
        out[`${relative(dir, p)}/`] = "";
        walk(p);
      } else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("project setup for Claude Code leaves the user's client config untouched (ynm #195)", () => {
  // A fake `claude` that logs every call, so a `claude mcp add` would show.
  const bin = temp("ynm-fakeclaude-");
  const calls = join(bin, "calls.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`);
  chmodSync(join(bin, "claude"), 0o755);

  const world = temp("ynm-world-");
  const origin = join(world, "origin.git");
  const one = join(world, "one");
  const two = join(world, "two");
  const home = temp("ynm-user-home-");
  const ynmHomeOne = temp("ynm-home-one-");
  const ynmHomeTwo = temp("ynm-home-two-");
  const envFor = (ynmHome: string) => ({
    HOME: home,
    YNM_HOME: ynmHome,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  });

  it("writes only project files, runs no claude command and leaves home alone", () => {
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    mkdirSync(one);
    git(one, "init", "-q", "-b", "main");
    git(one, "commit", "-q", "--allow-empty", "-m", "first");
    git(one, "remote", "add", "origin", origin);

    const homeBefore = snapshot(home);
    const ynmHomeBefore = snapshot(ynmHomeOne);
    const worldBefore = Object.keys(snapshot(world, ["one"]));

    const env = envFor(ynmHomeOne);
    const init = ynmWith(one, { env }, "init", "--no-clients");
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).not.toMatch(/\n {2}client {4}/);
    const install = ynmWith(one, { env }, "client", "install", "claude-code");
    expect(install.status, install.stderr).toBe(0);

    // Outside the project: nothing under the user's home or ynm's home, no new sibling of the project.
    expect(snapshot(home)).toEqual(homeBefore);
    expect(snapshot(ynmHomeOne)).toEqual(ynmHomeBefore);
    expect(Object.keys(snapshot(world, ["one"]))).toEqual(worldBefore);
    // The user's own Claude Code config is never written: `claude` is only ever asked for its version.
    const log = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    expect(log).not.toMatch(/\bmcp\b/);

    // Inside the project: the three files the guide says, nothing else the work tree can see.
    const status = git(one, "status", "--short", "-uall")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3))
      // Claude Code's personal settings file; a global gitignore may hide it, so it is checked apart.
      .filter((f) => f !== ".claude/settings.local.json")
      .sort();
    expect(status).toEqual([".mcp.json", "CLAUDE.md"]);
    expect(existsSync(join(one, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(one, ".claude", "settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(one, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { ynm: { command: "ynm", args: ["serve"] } },
    });
    expect(readFileSync(join(one, "CLAUDE.md"), "utf8")).toMatch(/<!-- ynm:guidance -->/);
  });

  it("a fresh clone reads the first clone's distributed memory", () => {
    const env = envFor(ynmHomeOne);
    const remembered = ynmWith(
      one,
      { env },
      "remember",
      "--type",
      "semantic",
      "--level",
      "distributed",
      "--content",
      "the tutorial series keeps memory with the repository"
    );
    expect(remembered.status, remembered.stderr).toBe(0);
    // Commit what the install wrote (the team shares it), then push the branch and the memory.
    git(one, "add", ".mcp.json", "CLAUDE.md");
    git(one, "commit", "-q", "-m", "ynm project setup");
    git(one, "push", "-q", "origin", "main");
    const synced = ynmWith(one, { env }, "sync");
    expect(synced.status, synced.stderr).toBe(0);

    git(world, "clone", "-q", origin, two);
    // The clone already has the committed client files; it needs only its own init.
    expect(existsSync(join(two, ".mcp.json"))).toBe(true);
    expect(existsSync(join(two, ".ynm"))).toBe(false);
    const envTwo = envFor(ynmHomeTwo);
    const init = ynmWith(two, { env: envTwo }, "init", "--no-clients");
    expect(init.status, init.stderr).toBe(0);
    const sync = ynmWith(two, { env: envTwo }, "sync");
    expect(sync.status, sync.stderr).toBe(0);
    const recalled = ynmWith(two, { env: envTwo }, "recall", "--text", "tutorial series", "--json");
    expect(recalled.status, recalled.stderr).toBe(0);
    const hits = JSON.parse(recalled.stdout) as { summary: string; mount: string }[];
    expect(hits.map((h) => h.summary).join("\n")).toMatch(/tutorial series keeps memory/);
    expect(hits[0]?.mount).toBe("project");
    // Nothing in the clone's own home or the user's home was needed either.
    expect(snapshot(home)).toEqual({});
  });
});
