import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRepo } from "@ynm/store/testing/git";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const cli = join(repoRoot, "packages", "cli", "bin", "run.js");
const mcpBin = join(repoRoot, "packages", "mcp", "bin", "run.js");

/** The MVP script (ADR-014): init, install, two agent sessions, recall across them. */
describe("tier1 e2e: MVP demo", () => {
  it("init, client install, remember in one process, recall in another", async () => {
    const repo = await createRepo(2);
    const home = join(mkdtempSync(join(tmpdir(), "ynm-mvp-home-")), ".ynm");
    const env = { ...process.env, YNM_HOME: home, YNM_USER: "demo", YNM_NO_CLAUDE_CLI: "1" };
    const ynm = (...args: string[]) =>
      spawnSync("node", [cli, ...args], { cwd: repo, encoding: "utf8", env });
    expect(ynm("init", "--no-hooks").status).toBe(0);
    expect(ynm("client", "install", "claude-code").status).toBe(0);
    const mcpConfig = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: { ynm: { command: string; args: string[] } };
    };
    expect(mcpConfig.mcpServers.ynm).toEqual({ command: "ynm", args: ["serve"] });
    // no instruction file existed, so the guidance lands in AGENTS.md, which Claude Code reads
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);

    const session = async () => {
      const client = new Client({ name: "demo", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [mcpBin, "--stdio"],
          cwd: repo,
          env: env as Record<string, string>,
          stderr: "pipe",
        })
      );
      return client;
    };
    const one = await session();
    const r = await one.callTool({
      name: "memory_remember",
      arguments: {
        type: "procedural",
        level: "distributed",
        content: "Release checklist: run the release gate before tagging.",
      },
    });
    expect(r.isError).toBeFalsy();
    await one.close();

    const two = await session();
    const hits = await two.callTool({
      name: "memory_recall",
      arguments: { text: "release tagging gate" },
    });
    const found = (hits.structuredContent as { data: Array<{ content: string }> }).data;
    expect(found[0]?.content).toMatch(/release gate/);
    await two.close();

    const listed = JSON.parse(ynm("list", "--json").stdout) as Array<{ mount: string }>;
    expect(listed.map((m) => m.mount)).toEqual(["project"]);
  }, 60_000);
});
