import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guidance } from "@ynm/model";
import type {
  stdioServerEntry as _unused,
  Change,
  ClientAdapter,
  ClientStatus,
  Detection,
  InstallTarget,
} from "./types.js";
import { stdioServerEntry } from "./types.js";

export const CLAUDE_MD_MARKER = "<!-- ynm:guidance -->";

/** The block appended to CLAUDE.md, delimited so re-installs replace rather than duplicate it. */
export function claudeMdBlock(): string {
  return `${CLAUDE_MD_MARKER}\n${guidance("session-start").trim()}\n${CLAUDE_MD_MARKER}\n`;
}

/**
 * Claude Code: project scope writes `.mcp.json` (mcpServers) and a delimited block in CLAUDE.md;
 * user scope goes through `claude mcp add` so the user's own config file is not hand-edited.
 */
export const claudeCode: ClientAdapter = {
  name: "claude-code",
  async detect({ cwd, home }): Promise<Detection> {
    const project = existsSync(join(cwd, ".mcp.json"));
    const user = existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude"));
    return {
      installed: project || user,
      detail: project
        ? "project .mcp.json present"
        : user
          ? "user config present"
          : "no Claude Code config found",
    };
  },
  async plan(t: InstallTarget): Promise<Change[]> {
    const entry = stdioServerEntry(t.transport);
    if (t.scope === "user") {
      const argv =
        t.transport.kind === "stdio"
          ? [
              "claude",
              "mcp",
              "add",
              "--scope",
              "user",
              "ynm",
              "--",
              t.transport.command,
              ...t.transport.args,
            ]
          : [
              "claude",
              "mcp",
              "add",
              "--scope",
              "user",
              "--transport",
              "http",
              "ynm",
              t.transport.url,
            ];
      return [{ kind: "command", argv, reason: "register ynm with Claude Code for this user" }];
    }
    const changes: Change[] = [
      {
        kind: "merge-json",
        path: join(t.cwd, ".mcp.json"),
        patch: { mcpServers: { ynm: entry } },
        reason: "register the ynm MCP server for this project",
      },
    ];
    const claudeMd = join(t.cwd, "CLAUDE.md");
    const existing = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
    const block = claudeMdBlock();
    const stripped = existing.includes(CLAUDE_MD_MARKER)
      ? existing.replace(new RegExp(`${CLAUDE_MD_MARKER}[\\s\\S]*?${CLAUDE_MD_MARKER}\\n?`), "")
      : existing;
    const content = `${stripped.trimEnd()}${stripped.trim() ? "\n\n" : ""}${block}`;
    if (content !== existing)
      changes.push({
        kind: "write",
        path: claudeMd,
        content,
        reason: "memory guidance for the agent (delimited block)",
      });
    return changes;
  },
  async status({ cwd, home }): Promise<ClientStatus> {
    const file = join(cwd, ".mcp.json");
    if (existsSync(file)) {
      const cfg = JSON.parse(readFileSync(file, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (cfg.mcpServers?.ynm)
        return { client: "claude-code", configured: true, detail: `project scope: ${file}` };
    }
    const userFile = join(home, ".claude.json");
    if (existsSync(userFile)) {
      const text = readFileSync(userFile, "utf8");
      if (/"ynm"\s*:/.test(text))
        return { client: "claude-code", configured: true, detail: `user scope: ${userFile}` };
    }
    return {
      client: "claude-code",
      configured: false,
      detail: "ynm not registered; run `ynm client install claude-code`",
    };
  },
};

export type { _unused };
