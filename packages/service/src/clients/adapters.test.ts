import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { TOOL_SPECS } from "../tools.js";
import {
  AGENTS_MD_MARKER,
  applyChanges,
  CLIENT_ADAPTERS,
  type ClientReport,
  claudeCode,
  claudeHooksPresent,
  clientReports,
  copilotCli,
  formatClientReport,
  opencode,
  pi,
  piExtensionSource,
  piSkill,
  typeboxSource,
} from "./index.js";

const stdio = { kind: "stdio" as const, command: "ynm", args: ["serve"] };
const http = { kind: "http" as const, url: "https://memory.example.com/mcp", bearer: "t0k3n" };
const golden = join(import.meta.dirname, "..", "..", "test", "golden", "clients");
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

/** Compares with a golden file; YNM_WRITE_GOLDEN=1 rewrites it. */
function expectGolden(name: string, actual: string): void {
  const file = join(golden, name);
  if (process.env.YNM_WRITE_GOLDEN === "1" || !existsSync(file)) {
    mkdirSync(golden, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

function temp(): { cwd: string; home: string } {
  return {
    cwd: mkdtempSync(join(tmpdir(), "ynm-cl-cwd-")),
    home: mkdtempSync(join(tmpdir(), "ynm-cl-home-")),
  };
}

describe("copilot-cli adapter (ADR-013)", () => {
  it("writes ~/.copilot/mcp-config.json for stdio and http, and the AGENTS.md block at project scope", async () => {
    const { cwd, home } = temp();
    const plan = await copilotCli.plan({ cwd, home, scope: "project", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["merge-json", "write"]);
    await applyChanges(plan);
    expectGolden(
      "copilot-mcp-config.stdio.json",
      readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")
    );
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8").split(AGENTS_MD_MARKER)).toHaveLength(3);
    expect((await copilotCli.status({ cwd, home })).configured).toBe(true);
    const again = await copilotCli.plan({ cwd, home, scope: "project", transport: stdio });
    expect(again.map((c) => c.kind)).toEqual(["merge-json"]);
    const remote = temp();
    await applyChanges(await copilotCli.plan({ ...remote, scope: "user", transport: http }));
    expectGolden(
      "copilot-mcp-config.http.json",
      readFileSync(join(remote.home, ".copilot", "mcp-config.json"), "utf8")
    );
    expect(existsSync(join(remote.cwd, "AGENTS.md"))).toBe(false);
  });
});

describe("opencode adapter (ADR-013)", () => {
  it("merges opencode.json at project scope, ~/.config/opencode at user scope, keeps other servers", async () => {
    const { cwd, home } = temp();
    writeFileSync(
      join(cwd, "opencode.json"),
      JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } } })
    );
    await applyChanges(await opencode.plan({ cwd, home, scope: "project", transport: stdio }));
    const cfg = JSON.parse(readFileSync(join(cwd, "opencode.json"), "utf8")) as {
      mcp: Record<string, unknown>;
      $schema?: string;
    };
    expect(Object.keys(cfg.mcp).sort()).toEqual(["other", "ynm"]);
    expect(cfg.$schema).toBeUndefined();
    expectGolden("opencode.project.json", readFileSync(join(cwd, "opencode.json"), "utf8"));
    expect((await opencode.status({ cwd, home })).configured).toBe(true);
    const user = temp();
    await applyChanges(await opencode.plan({ ...user, scope: "user", transport: http }));
    expectGolden(
      "opencode.user.json",
      readFileSync(join(user.home, ".config", "opencode", "opencode.json"), "utf8")
    );
    expect(readFileSync(join(user.home, ".config", "opencode", "AGENTS.md"), "utf8")).toContain(
      AGENTS_MD_MARKER
    );
    expect((await opencode.status(user)).configured).toBe(true);
  });
});

describe("pi adapter (ADR-013)", () => {
  it("generates one TypeBox tool per tool spec; the checked-in extension and skill match", () => {
    const src = piExtensionSource();
    for (const spec of TOOL_SPECS) expect(src).toContain(`name: ${JSON.stringify(spec.name)},`);
    expect(src).not.toContain("Type.Any(");
    expect(readFileSync(join(repoRoot, "clients", "pi", "ynm.ts"), "utf8")).toBe(src);
    expect(readFileSync(join(repoRoot, "clients", "pi", "SKILL.md"), "utf8")).toBe(piSkill());
    expectGolden("pi-extension.ts.txt", src);
  });

  it("converts the JSON Schema subset Zod emits", () => {
    expect(typeboxSource({ type: "string", enum: ["a", "b"] })).toBe(
      'Type.Union([Type.Literal("a"), Type.Literal("b")])'
    );
    expect(
      typeboxSource({
        type: "object",
        properties: { n: { type: "integer", minimum: 1 } },
        required: ["n"],
      })
    ).toBe('Type.Object({ "n": Type.Integer({"minimum":1}) })');
    expect(typeboxSource({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(
      "Type.Union([Type.String(), Type.Null()])"
    );
    expect(typeboxSource({ type: "array", items: { type: "string" }, description: "tags" })).toBe(
      'Type.Array(Type.String(), {"description":"tags"})'
    );
  });

  it("installs under ~/.pi/agent (user) or .pi (project) and reports status", async () => {
    const { cwd, home } = temp();
    const plan = await pi.plan({ cwd, home, scope: "user", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["write", "write"]);
    await applyChanges(plan);
    expect(existsSync(join(home, ".pi", "agent", "extensions", "ynm.ts"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "skills", "ynm-memory", "SKILL.md"))).toBe(true);
    expect((await pi.status({ cwd, home })).configured).toBe(true);
    expect(await pi.plan({ cwd, home, scope: "user", transport: stdio })).toEqual([]);
    const project = await pi.plan({ cwd, home, scope: "project", transport: stdio });
    expect(project.map((c) => c.path)).toEqual([
      join(cwd, ".pi", "extensions", "ynm.ts"),
      join(cwd, ".pi", "skills", "ynm-memory", "SKILL.md"),
      join(cwd, "AGENTS.md"),
    ]);
  });

  it("the extension's tools run the ynm CLI and return its JSON as details", async () => {
    // Compile the generated TypeScript, stub TypeBox, load it with a fake Pi API.
    const dir = mkdtempSync(join(tmpdir(), "ynm-pi-ext-"));
    const js = ts.transpileModule(
      piExtensionSource().replace('from "@earendil-works/pi-ai"', 'from "./typebox.mjs"'),
      {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }
    ).outputText;
    writeFileSync(
      join(dir, "typebox.mjs"),
      "export const Type = new Proxy({}, { get: (_, k) => (...a) => ({ kind: k, args: a }) });\n"
    );
    writeFileSync(join(dir, "ynm.mjs"), js);
    const mod = (await import(pathToFileURL(join(dir, "ynm.mjs")).href)) as {
      default: (pi: unknown) => void;
      argsFor: (c: string, p: Record<string, unknown>) => string[];
    };
    const tools = new Map<
      string,
      {
        schema: unknown;
        execute: (p: Record<string, unknown>) => Promise<{ content: string; details?: unknown }>;
      }
    >();
    mod.default({ registerTool: (t: Tool) => tools.set(t.name, t) });
    expect([...tools.keys()]).toEqual(TOOL_SPECS.map((t) => t.name));
    expect((tools.get("memory_remember")?.parameters as { kind: string } | undefined)?.kind).toBe(
      "Object"
    );
    expect(
      mod.argsFor("remember", {
        type: "semantic",
        tags: ["a", "b"],
        pinned: true,
        data: { k: 1 },
        budgetTokens: 3,
      })
    ).toEqual([
      "remember",
      "--json",
      "--type",
      "semantic",
      "--tags",
      "a",
      "--tags",
      "b",
      "--pinned",
      "--data",
      '{"k":1}',
      "--budget-tokens",
      "3",
    ]);

    const repo = mkdtempSync(join(tmpdir(), "ynm-pi-repo-"));
    spawnSync("git", ["init", "-q", repo]);
    const home = join(mkdtempSync(join(tmpdir(), "ynm-pi-home-")), ".ynm");
    const bin = join(dir, "ynm");
    writeFileSync(
      bin,
      `#!/bin/sh
cmd=$1; shift
exec ${process.execPath} ${join(repoRoot, "packages", "cli", "bin", "run.js")} "$cmd" --cwd ${repo} "$@"
`,
      { mode: 0o755 }
    );
    process.env.YNM_BIN = bin;
    process.env.YNM_HOME = home;
    process.env.YNM_NO_CLAUDE_CLI = "1";
    try {
      const r = await tools
        .get("memory_remember")
        ?.execute("call-1", { type: "semantic", content: "pi remembers", level: "personal" });
      expect((r?.details as { memoryId: string } | undefined)?.memoryId).toMatch(/^[0-9A-Z]{26}$/);
      const hits = await tools.get("memory_recall")?.execute("call-2", { text: "pi remembers" });
      expect((hits?.details as Array<{ content: string }> | undefined)?.[0]?.content).toBe(
        "pi remembers"
      );
      const bad = await tools
        .get("memory_remember")
        ?.execute("call-3", { type: "nope", content: "x" });
      expect(bad?.content[0]?.text).toMatch(/exited/);
    } finally {
      delete process.env.YNM_BIN;
    }
  }, 60_000);
});

describe("claude-code hooks (ADR-016)", () => {
  it("merges the three hooks into .claude/settings.json, keeping other hooks and keys, once", async () => {
    const { cwd, home } = temp();
    const settings = join(cwd, ".claude", "settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        permissions: { allow: ["Bash(make test)"] },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "./lint.sh" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
        },
      })
    );
    const plan = await claudeCode.plan({ cwd, home, scope: "project", transport: stdio });
    expect(plan.map((c) => (c.kind === "command" ? c.kind : c.path))).toEqual([
      join(cwd, ".mcp.json"),
      join(cwd, "CLAUDE.md"),
      settings,
    ]);
    await applyChanges(plan);
    expectGolden("claude-settings.project.json", readFileSync(settings, "utf8"));
    expect(claudeHooksPresent(settings)).toEqual({
      SessionStart: true,
      UserPromptSubmit: true,
      Stop: true,
    });
    const again = await claudeCode.plan({ cwd, home, scope: "project", transport: stdio });
    expect(again.map((c) => (c.kind === "command" ? c.kind : c.path))).toEqual([
      join(cwd, ".mcp.json"),
    ]);
  });

  it("--no-hooks leaves the settings alone and status reports the gap", async () => {
    const { cwd, home } = temp();
    await applyChanges(
      await claudeCode.plan({ cwd, home, scope: "project", transport: stdio, hooks: false })
    );
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(false);
    const s = await claudeCode.status({ cwd, home });
    expect(s).toMatchObject({ configured: true, guidance: true, hooks: false });
    const report = (await clientReports({ cwd, home })).find((r) => r.client === "claude-code");
    expect(report).toMatchObject({
      level: "warn",
      advice: "hooks missing; run `ynm client install claude-code`",
    });
    expect(formatClientReport(report as ClientReport)).toMatch(
      /^warn claude-code: server yes, guidance yes, hooks no; hooks missing/
    );
    await applyChanges(await claudeCode.plan({ cwd, home, scope: "project", transport: stdio }));
    const fixed = (await clientReports({ cwd, home })).find((r) => r.client === "claude-code");
    expect(fixed?.level).toBe("ok");
  });
});

describe("registry (ADR-013)", () => {
  it("lists the supported clients in a stable order", () => {
    expect(CLIENT_ADAPTERS.map((c) => c.name)).toEqual([
      "claude-code",
      "copilot-cli",
      "opencode",
      "pi",
      "ynh",
    ]);
  });
});
