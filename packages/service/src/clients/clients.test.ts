import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyChanges,
  CLAUDE_MD_MARKER,
  claudeCode,
  clientAdapter,
  clientReports,
  onPath,
  stdioServerEntry,
  YNH_ENV_PASSTHROUGH,
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
      readFileSync(
        join(repoRoot, "integrations", "ynh", ".agents", "harness", "plugin.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    const generated = ynhPlugin({ version: String(checked.version), transport: stdio });
    expect(generated).toEqual(checked);
    expect(
      readFileSync(join(repoRoot, "integrations", "skills", "ynm-memory", "SKILL.md"), "utf8")
    ).toBe(ynhSkill());
  });

  it("ynh install is a command and status finds an installed harness", async () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-ynh-home-"));
    expect((await ynh.status({ cwd: "/x", home })).configured).toBe(false);
    const plan = await ynh.plan({ cwd: "/x", home, scope: "user", transport: stdio });
    expect(plan[0]).toMatchObject({
      kind: "command",
      argv: ["ynh", "install", "github.com/eyelock/ynm", "--path", "integrations/ynh"],
    });
    const dir = join(home, ".ynh", "harnesses", "eyelock", "ynm", ".agents", "harness");
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

  it("ynh in a harness merges the server, hooks and a skill include into it, idempotently", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    const home = mkdtempSync(join(tmpdir(), "ynm-ynh-home-"));
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "harness", "plugin.json"),
      JSON.stringify({
        name: "my-harness",
        version: "0.1.0",
        mcp_servers: { ynm: { command: "ynm serve" }, other: { command: "x" } },
        hooks: { on_stop: [{ command: "./cleanup.sh" }] },
        env_passthrough: ["GITHUB_TOKEN", "YNM_USER"],
      })
    );
    expect((await ynh.detect({ cwd, home })).installed).toBe(true);
    const plan = await ynh.plan({ cwd, home, scope: "project", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["write", "note"]);
    expect(plan[0]?.reason).toMatch(/replaced the string-form command "ynm serve"/);
    expect(plan[1]).toMatchObject({ kind: "note", text: "ynm validate" });
    await applyChanges(plan);
    const m = JSON.parse(readFileSync(join(cwd, ".agents", "harness", "plugin.json"), "utf8")) as {
      mcp_servers: Record<string, unknown>;
      hooks: Record<string, Array<{ command: string }>>;
      env_passthrough: string[];
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
    // the skill arrives by include, resolved by ynh; nothing is copied into the harness
    expect((m as unknown as { includes: unknown[] }).includes).toEqual([
      {
        git: "https://github.com/eyelock/ynm",
        path: "integrations",
        pick: ["skills/ynm-memory"],
      },
    ]);
    expect(existsSync(join(cwd, "skills"))).toBe(false);
    // existing entries stay, ynm's are added once
    expect(m.env_passthrough).toEqual([
      "GITHUB_TOKEN",
      "YNM_USER",
      ...YNH_ENV_PASSTHROUGH.filter((v) => v !== "YNM_USER"),
    ]);
    expect(await ynh.plan({ cwd, home, scope: "project", transport: stdio })).toEqual([]);
    expect(await ynh.status({ cwd, home })).toMatchObject({
      configured: true,
      guidance: true,
      hooks: true,
      env: true,
    });
    const ynd = spawnSync("ynd", ["validate", cwd], { encoding: "utf8" });
    if (!ynd.error) expect(`${ynd.stdout}${ynd.stderr}`).toMatch(/: valid$/m);
  });

  it("ynh reports a harness whose env_passthrough lacks YNM_HOME as not fully configured", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "harness", "plugin.json"),
      JSON.stringify({ name: "h", mcp_servers: { ynm: { command: "ynm", args: ["serve"] } } })
    );
    expect((await ynh.status({ cwd, home: cwd })).env).toBe(false);
    const report = (await clientReports({ cwd, home: cwd })).find((r) => r.client === "ynh");
    expect(report?.level).toBe("warn");
    expect(report?.advice).toMatch(/env_passthrough.*YNM_HOME.*run `ynm client install ynh`/);
    await applyChanges(await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio }));
    expect((await ynh.status({ cwd, home: cwd })).env).toBe(true);
  });

  it("ynh --no-hooks merges only the server and the skill include", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "harness", "plugin.json"),
      JSON.stringify({ name: "h", version: "0.1.0" })
    );
    await applyChanges(
      await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio, hooks: false })
    );
    const m = JSON.parse(readFileSync(join(cwd, ".agents", "harness", "plugin.json"), "utf8")) as {
      hooks?: unknown;
    };
    expect(m.hooks).toBeUndefined();
    expect((await ynh.status({ cwd, home: cwd })).hooks).toBe(false);
  });

  it("keeps a harness manifest's own formatting when merging into it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    const file = join(cwd, ".agents", "harness", "plugin.json");
    writeFileSync(
      file,
      '{\n    "$schema": "https://eyelock.github.io/ynh/schema/plugin.schema.json",\n    "name": "h",\n    "description": "yours \\u2014 your AI"\n}\n'
    );
    await applyChanges(await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio }));
    const text = readFileSync(file, "utf8");
    expect(text).toContain('    "description": "yours \\u2014 your AI"');
    expect(text).not.toContain("—");
  });

  it("registry rejects unknown clients", () => {
    expect(() => clientAdapter("cursor")).toThrow(/unknown client/);
  });
});

describe("ynh harness with the deprecated .ynh-plugin/ layout", () => {
  function legacy(extra: Record<string, unknown> = {}): string {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".ynh-plugin"));
    writeFileSync(
      join(cwd, ".ynh-plugin", "plugin.json"),
      JSON.stringify({ name: "h", version: "0.1.0", ...extra })
    );
    return cwd;
  }

  it("is still detected and reported, with a note that it should move", async () => {
    const cwd = legacy({ mcp_servers: { ynm: { command: "ynm", args: ["serve"] } } });
    expect((await ynh.detect({ cwd, home: cwd })).installed).toBe(true);
    const status = await ynh.status({ cwd, home: cwd });
    expect(status.configured).toBe(true);
    expect(status.detail).toMatch(/\.ynh-plugin.*deprecated.*\.agents\/harness/);
  });

  it("is moved to .agents/harness/ on install, leaving one manifest", async () => {
    const cwd = legacy();
    writeFileSync(join(cwd, ".ynh-plugin", "installed.json"), "{}");
    const plan = await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["move", "write", "note"]);
    await applyChanges(plan);
    expect(existsSync(join(cwd, ".ynh-plugin"))).toBe(false);
    expect(existsSync(join(cwd, ".agents", "harness", "installed.json"))).toBe(true);
    const m = JSON.parse(readFileSync(join(cwd, ".agents", "harness", "plugin.json"), "utf8")) as {
      mcp_servers: Record<string, unknown>;
    };
    expect(m.mcp_servers.ynm).toEqual({ command: "ynm", args: ["serve"] });
    expect(await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio })).toEqual([]);
  });

  it("moves just the manifest when .agents/harness/ already exists without one", async () => {
    const cwd = legacy();
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    await applyChanges(await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio }));
    expect(existsSync(join(cwd, ".ynh-plugin", "plugin.json"))).toBe(false);
    expect(existsSync(join(cwd, ".agents", "harness", "plugin.json"))).toBe(true);
  });

  it("prefers the canonical manifest when both exist and never touches the legacy one", async () => {
    const cwd = legacy();
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "harness", "plugin.json"), JSON.stringify({ name: "h" }));
    const plan = await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio });
    expect(plan.map((c) => c.kind)).toEqual(["write", "note"]);
    await applyChanges(plan);
    expect(existsSync(join(cwd, ".ynh-plugin", "plugin.json"))).toBe(true);
  });
});

describe("ynh include from before the skill moved to integrations/", () => {
  it("is replaced in place, not duplicated", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    const file = join(cwd, ".agents", "harness", "plugin.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "h",
        version: "0.1.0",
        includes: [
          { git: "https://github.com/eyelock/assistants", path: "skills/dev" },
          { git: "https://github.com/eyelock/ynm", pick: ["skills/ynm-memory"] },
        ],
      })
    );
    const plan = await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio });
    expect(plan[0]?.reason).toMatch(/updated to integrations\)/);
    await applyChanges(plan);
    const m = JSON.parse(readFileSync(file, "utf8")) as { includes: unknown[] };
    expect(m.includes).toEqual([
      { git: "https://github.com/eyelock/assistants", path: "skills/dev" },
      {
        git: "https://github.com/eyelock/ynm",
        path: "integrations",
        pick: ["skills/ynm-memory"],
      },
    ]);
  });
});

describe("ynh harness edges", () => {
  function harness(manifest: unknown): string {
    const cwd = mkdtempSync(join(tmpdir(), "ynm-harness-"));
    mkdirSync(join(cwd, ".agents", "harness"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "harness", "plugin.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest)
    );
    return cwd;
  }
  const http = { kind: "http" as const, url: "https://mem.example/mcp", bearer: "tok" };

  it("declares an http server in the plugin, with a bearer header only when one is set", () => {
    expect(ynhPlugin({ version: "1.0.0", transport: http }).mcp_servers).toEqual({
      ynm: { url: http.url, headers: { Authorization: "Bearer tok" } },
    });
    expect(
      ynhPlugin({ version: "1.0.0", transport: { kind: "http", url: http.url } }).mcp_servers
    ).toEqual({ ynm: { url: http.url } });
  });

  it("refuses to merge into a manifest that is not a JSON object", async () => {
    for (const bad of ["[1, 2]", "{ not json"]) {
      const cwd = harness(bad);
      const plan = await ynh.plan({ cwd, home: cwd, scope: "project", transport: stdio });
      expect(plan).toEqual([
        expect.objectContaining({ kind: "note", reason: "harness manifest unreadable" }),
      ]);
      expect((await ynh.status({ cwd, home: cwd })).configured).toBe(false);
    }
  });

  it("switches a stdio server to http, keeping its env, and adds only the missing hook", async () => {
    const cwd = harness({
      $schema: "https://eyelock.github.io/ynh/schema/plugin.schema.json",
      name: "h",
      mcp_servers: { ynm: { command: "ynm", args: ["serve"], env: { A: "1" } } },
      includes: [{ git: "https://github.com/eyelock/ynm.git", path: "integrations", pick: "all" }],
      hooks: {
        on_session_start: [{ command: "ynm hook session-start" }],
        before_prompt: [{ command: " ynm hook prompt " }],
      },
    });
    const plan = await ynh.plan({ cwd, home: cwd, scope: "project", transport: http });
    expect(plan[0]).toMatchObject({
      kind: "write",
      reason: "harness manifest: mcp_servers.ynm; env_passthrough; hooks on_stop",
      label: "harness manifest, 1 hook",
    });
    await applyChanges(plan);
    const m = JSON.parse(readFileSync(join(cwd, ".agents", "harness", "plugin.json"), "utf8")) as {
      mcp_servers: Record<string, unknown>;
    };
    expect(m.mcp_servers.ynm).toEqual({
      url: http.url,
      headers: { Authorization: "Bearer tok" },
      env: { A: "1" },
    });
    const status = await ynh.status({ cwd, home: cwd });
    expect(status.checked?.[1]).toBe(`server    mcp_servers.ynm runs \`${http.url}\``);
    expect(await ynh.plan({ cwd, home: cwd, scope: "project", transport: http })).toEqual([]);
  });

  it("reports a harness that does not declare ynm, with a copied skill as its guidance", async () => {
    const cwd = harness({ name: "h" });
    mkdirSync(join(cwd, "skills", "ynm-memory"), { recursive: true });
    writeFileSync(join(cwd, "skills", "ynm-memory", "SKILL.md"), "skill");
    const status = await ynh.status({ cwd, home: cwd });
    expect(status).toMatchObject({
      configured: false,
      guidance: true,
      hooks: false,
      detail: "harness here; ynm not declared; run `ynm client install ynh`",
    });
    expect(status.checked?.slice(1)).toEqual([
      "server    missing",
      `guidance  ${join(cwd, "skills", "ynm-memory", "SKILL.md")}`,
      expect.stringMatching(/^env {7}env_passthrough lacks YNM_HOME/),
      "hooks     missing",
    ]);
  });

  it("finds an installed ynm harness among others and says when its hooks are missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "ynm-ynh-home-"));
    mkdirSync(join(home, ".ynh"));
    expect((await ynh.status({ cwd: "/x", home })).detail).toMatch(/^run `ynh install/);
    const put = (dir: string, content: string) => {
      mkdirSync(join(home, ".ynh", dir, ".agents", "harness"), { recursive: true });
      writeFileSync(join(home, ".ynh", dir, ".agents", "harness", "plugin.json"), content);
    };
    put("broken", "{ not json");
    put("other", JSON.stringify({ name: "other" }));
    put("ynm", JSON.stringify({ name: "ynm", includes: [] }));
    const status = await ynh.status({ cwd: "/x", home });
    expect(status).toMatchObject({ configured: true, guidance: false, hooks: false });
    expect(status.detail).toMatch(/hooks missing \(an older release: run `ynh update ynm`\)/);
    // an installed harness lacking YNM_HOME is fixed by updating or reinstalling, not by client install
    expect(status.env).toBe(false);
    const report = (await clientReports({ cwd: "/x", home })).find((r) => r.client === "ynh");
    expect(report?.advice).toMatch(
      /env_passthrough \(YNM_HOME\) missing; run `ynh update ynm`, or reinstall with `ynh install github\.com\/eyelock\/ynm --path integrations\/ynh`/
    );
    expect(report?.advice).not.toMatch(/ynm client install/);
  });
});

describe("client helpers", () => {
  it("finds nothing on an empty or missing PATH", () => {
    expect(onPath("sh", {})).toBe(false);
    expect(onPath("sh", { PATH: "" })).toBe(false);
  });

  it("writes http server entries with an optional bearer", () => {
    expect(stdioServerEntry(stdio)).toEqual({ command: "ynm", args: ["serve"] });
    expect(stdioServerEntry({ kind: "http", url: "http://h/mcp" })).toEqual({
      type: "http",
      url: "http://h/mcp",
    });
    expect(stdioServerEntry({ kind: "http", url: "http://h/mcp", bearer: "b" })).toEqual({
      type: "http",
      url: "http://h/mcp",
      headers: { Authorization: "Bearer b" },
    });
  });
});
