/**
 * Milestone gate: M0 Skeleton. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..", "..", "..");

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

describe("gate M0: skeleton", () => {
  it("repo carries the ADR record (docs/adr/README.md and ADR-000)", () => {
    expect(existsSync(join(repo, "docs", "adr", "README.md"))).toBe(true);
    expect(existsSync(join(repo, "docs", "adr", "000-requirements.md"))).toBe(true);
  });

  it("ynh plugin manifest parses and declares the ynm MCP server", () => {
    const manifest = JSON.parse(readFileSync(join(repo, ".ynh-plugin", "plugin.json"), "utf8")) as {
      name: string;
      mcp_servers: Record<string, unknown>;
    };
    expect(manifest.name).toBe("ynm");
    expect(manifest.mcp_servers).toHaveProperty("ynm");
  });

  it("every package builds to dist with a type declaration", () => {
    for (const pkg of ["model", "store", "index", "service", "mcp", "cli", "wiki", "evals"]) {
      expect(existsSync(join(repo, "packages", pkg, "dist", "index.d.ts")), pkg).toBe(true);
    }
  });

  it("`ynm status --json` reports name and version", () => {
    const out = run("node", ["packages/cli/bin/run.js", "status", "--json"]);
    const parsed = JSON.parse(out) as { name: string; version: string };
    expect(parsed.name).toBe("ynm");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`ynm-mcp --version` prints", () => {
    expect(run("node", ["packages/mcp/bin/run.js", "--version"])).toMatch(/^ynm-mcp \d/);
  });
});
