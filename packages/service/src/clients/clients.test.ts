import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(plan.map((c) => c.kind)).toEqual(["merge-json", "write", "merge-json"]);
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
    const status = await claudeCode.status({ cwd, home });
    expect(status).toMatchObject({ configured: true, guidance: true, hooks: true });
  });

  it("claude-code user scope registers the server by command and merges hooks into ~/.claude/settings.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-cc-home-"));
    const plan = await claudeCode.plan({ cwd: "/x", home, scope: "user", transport: stdio });
    expect(plan).toEqual([
      expect.objectContaining({
        kind: "command",
        argv: expect.arrayContaining(["claude", "mcp", "add", "--scope", "user", "ynm"]),
      }),
      expect.objectContaining({ kind: "merge-json", path: join(home, ".claude", "settings.json") }),
    ]);
    const ran: string[][] = [];
    await applyChanges(plan, { runCommand: async (argv) => void ran.push(argv) });
    expect(ran).toHaveLength(1);
    const noHooks = await claudeCode.plan({
      cwd: "/x",
      home: mkdtempSync(join(tmpdir(), "ynm-cc-home-")),
      scope: "user",
      transport: stdio,
      hooks: false,
    });
    expect(noHooks.map((c) => c.kind)).toEqual(["command"]);
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

  it("ynh in a harness merges the server, hooks and skill into it, idempotently", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    const home = mkdtempSync(join(tmpdir(), "ynm-ynh-home-"));
    mkdirSync(join(cwd, ".ynh-plugin"));
    writeFileSync(
      join(cwd, ".ynh-plugin", "plugin.json"),
      JSON.stringify({
        name: "my-harness",
        version: "0.1.0",
        mcp_servers: { ynm: { command: "ynm serve" }, other: { command: "x" } },
        hooks: { on_stop: [{ command: "./cleanup.sh" }] },
      })
    );
    expect((await ynh.detect({ cwd, home })).installed).toBe(true);
    const plan = await ynh.plan({ cwd, home, scope: "project", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["write", "write", "note"]);
    expect(plan[0]?.reason).toMatch(/replaced the string-form command "ynm serve"/);
    expect(plan[2]).toMatchObject({ kind: "note", text: "ynd validate ." });
    await applyChanges(plan);
    const m = JSON.parse(readFileSync(join(cwd, ".ynh-plugin", "plugin.json"), "utf8")) as {
      mcp_servers: Record<string, unknown>;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(m.mcp_servers).toEqual({
      ynm: { command: "ynm", args: ["serve"] },
      other: { command: "x" },
    });
    expect(m.hooks).toEqual({
      on_stop: [{ command: "./cleanup.sh" }, { command: "ynm hook stop" }],
      on_session_start: [{ command: "ynm hook session-start" }],
      before_prompt: [{ command: "ynm hook prompt" }],
    });
    expect(readFileSync(join(cwd, "skills", "ynm-memory", "SKILL.md"), "utf8")).toBe(ynhSkill());
    expect(await ynh.plan({ cwd, home, scope: "project", transport: stdio })).toEqual([]);
    expect(await ynh.status({ cwd, home })).toMatchObject({
      configured: true,
      guidance: true,
      hooks: true,
    });
    const ynd = spawnSync("ynd", ["validate", cwd], { encoding: "utf8" });
    if (!ynd.error) expect(`${ynd.stdout}${ynd.stderr}`).toMatch(/: valid$/m);
  });

  it("ynh --no-hooks merges only the server and skill", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".ynh-plugin"));
    writeFileSync(
      join(cwd, ".ynh-plugin", "plugin.json"),
      JSON.stringify({ name: "h", version: "0.1.0" })
    );
    await applyChanges(
      await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio, hooks: false })
    );
    const m = JSON.parse(readFileSync(join(cwd, ".ynh-plugin", "plugin.json"), "utf8")) as {
      hooks?: unknown;
    };
    expect(m.hooks).toBeUndefined();
    expect((await ynh.status({ cwd, home: cwd })).hooks).toBe(false);
  });

  it("registry rejects unknown clients", () => {
    expect(() => clientAdapter("cursor")).toThrow(/unknown client/);
  });
});
