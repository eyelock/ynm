import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyChanges,
  CLAUDE_MD_MARKER,
  claudeCode,
  clientAdapter,
  ynh,
  ynhPlugin,
  ynhSkill,
} from "./index.js";

const stdio = { kind: "stdio" as const, command: "ynm", args: ["serve"] };

describe("client adapters (ADR-013)", () => {
  it("claude-code project scope merges .mcp.json and appends a delimited CLAUDE.md block, idempotently", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-cc-"));
    const home = mkdtempSync(join(tmpdir(), "ynm-cc-home-"));
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } })
    );
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project\n\nExisting notes.\n");
    const plan = await claudeCode.plan({ cwd, home, scope: "project", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["merge-json", "write"]);
    await applyChanges(plan);
    const cfg = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["other", "ynm"]);
    expect(cfg.mcpServers.ynm).toEqual({ command: "ynm", args: ["serve"] });
    const md = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(md.startsWith("# Project\n\nExisting notes.\n\n")).toBe(true);
    expect(md.split(CLAUDE_MD_MARKER)).toHaveLength(3);
    const again = await claudeCode.plan({ cwd, home, scope: "project", transport: stdio });
    expect(again.map((c) => c.kind)).toEqual(["merge-json"]);
    expect((await claudeCode.status({ cwd, home })).configured).toBe(true);
  });

  it("claude-code user scope is a command, never a hand edit of the user's config", async () => {
    const plan = await claudeCode.plan({ cwd: "/x", home: "/y", scope: "user", transport: stdio });
    expect(plan).toEqual([
      expect.objectContaining({
        kind: "command",
        argv: expect.arrayContaining(["claude", "mcp", "add", "--scope", "user", "ynm"]),
      }),
    ]);
    const ran: string[][] = [];
    await applyChanges(plan, { runCommand: async (argv) => void ran.push(argv) });
    expect(ran).toHaveLength(1);
  });

  it("ynh plugin generation matches the checked-in manifest and skill", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const checked = JSON.parse(
      readFileSync(join(repoRoot, ".ynh-plugin", "plugin.json"), "utf8")
    ) as Record<string, unknown>;
    const generated = ynhPlugin({ version: String(checked.version), transport: stdio });
    expect(generated).toEqual(checked);
    expect(readFileSync(join(repoRoot, "skills", "ynm-memory", "SKILL.md"), "utf8")).toBe(
      ynhSkill()
    );
  });

  it("ynh install is a command and status finds an installed harness", async () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-ynh-home-"));
    expect((await ynh.status({ cwd: "/x", home })).configured).toBe(false);
    const plan = await ynh.plan({ cwd: "/x", home, scope: "user", transport: stdio });
    expect(plan[0]).toMatchObject({
      kind: "command",
      argv: ["ynh", "install", "github.com/eyelock/ynm"],
    });
    const dir = join(home, ".ynh", "harnesses", "eyelock", "ynm", ".ynh-plugin");
    await applyChanges([
      {
        kind: "write",
        path: join(dir, "plugin.json"),
        content: JSON.stringify({ name: "ynm" }),
        reason: "simulate install",
      },
    ]);
    expect((await ynh.status({ cwd: "/x", home })).configured).toBe(true);
  });

  it("registry rejects unknown clients", () => {
    expect(() => clientAdapter("cursor")).toThrow(/unknown client/);
  });
});
