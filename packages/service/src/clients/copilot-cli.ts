import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_MD_MARKER, agentsMdBlock, delimitedBlockChange } from "./agents-md.js";
import type {
  Change,
  ClientAdapter,
  ClientStatus,
  Detection,
  InstallTarget,
  Transport,
} from "./types.js";

/** Copilot CLI's server entry: `local` (stdio) or `http`, tools allow-listed with "*". */
export function copilotServerEntry(t: Transport): Record<string, unknown> {
  return t.kind === "stdio"
    ? { type: "local", command: t.command, args: t.args, tools: ["*"] }
    : {
        type: "http",
        url: t.url,
        ...(t.bearer ? { headers: { Authorization: `Bearer ${t.bearer}` } } : {}),
        tools: ["*"],
      };
}

export const COPILOT_CONFIG = (home: string): string => join(home, ".copilot", "mcp-config.json");

/**
 * GitHub Copilot CLI: MCP servers live in `~/.copilot/mcp-config.json` (user level, the only
 * place the CLI reads them); project scope adds the guidance block to AGENTS.md, which Copilot
 * CLI reads alongside `.github/copilot-instructions.md`.
 */
export const copilotCli: ClientAdapter = {
  name: "copilot-cli",
  async detect({ home }): Promise<Detection> {
    const present = existsSync(join(home, ".copilot"));
    return {
      installed: present,
      detail: present ? "~/.copilot present" : "no Copilot CLI config found",
    };
  },
  async plan(t: InstallTarget): Promise<Change[]> {
    const changes: Change[] = [
      {
        kind: "merge-json",
        path: COPILOT_CONFIG(t.home),
        patch: { mcpServers: { ynm: copilotServerEntry(t.transport) } },
        reason:
          "register the ynm MCP server with Copilot CLI (user level; the CLI reads only this file)",
      },
    ];
    if (t.scope === "project") {
      const c = delimitedBlockChange(
        join(t.cwd, "AGENTS.md"),
        agentsMdBlock(),
        AGENTS_MD_MARKER,
        "memory guidance for the agent (delimited block in AGENTS.md)"
      );
      if (c) changes.push(c);
    }
    return changes;
  },
  async status({ home }): Promise<ClientStatus> {
    const file = COPILOT_CONFIG(home);
    if (existsSync(file)) {
      const cfg = JSON.parse(readFileSync(file, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (cfg.mcpServers?.ynm) return { client: "copilot-cli", configured: true, detail: file };
    }
    return {
      client: "copilot-cli",
      configured: false,
      detail: "ynm not registered; run `ynm client install copilot-cli`",
    };
  },
};
