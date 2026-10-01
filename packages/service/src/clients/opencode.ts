import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS_MD_MARKER,
  agentsMdBlock,
  delimitedBlockChange,
  hasGuidanceBlock,
} from "./agents-md.js";
import type {
  Change,
  ClientAdapter,
  ClientStatus,
  Detection,
  InstallTarget,
  Transport,
} from "./types.js";
import { detectBySignals } from "./types.js";

/** OpenCode's `mcp` entry: `local` takes the whole command as an array; `remote` takes url and headers. */
export function opencodeServerEntry(t: Transport): Record<string, unknown> {
  return t.kind === "stdio"
    ? { type: "local", command: [t.command, ...t.args], enabled: true }
    : {
        type: "remote",
        url: t.url,
        enabled: true,
        ...(t.bearer ? { headers: { Authorization: `Bearer ${t.bearer}` } } : {}),
      };
}

export function opencodeConfigPath(t: Pick<InstallTarget, "cwd" | "home" | "scope">): string {
  return t.scope === "user"
    ? join(t.home, ".config", "opencode", "opencode.json")
    : join(t.cwd, "opencode.json");
}

/**
 * OpenCode: `opencode.json` at the project root (project scope) or `~/.config/opencode/`
 * (user scope) with the `mcp` block; AGENTS.md carries the guidance in both scopes because
 * OpenCode reads the project's AGENTS.md and the global one under `~/.config/opencode/`.
 */
export const opencode: ClientAdapter = {
  name: "opencode",
  async detect(t): Promise<Detection> {
    return detectBySignals(
      {
        bin: "opencode",
        user: [join(".config", "opencode")],
        project: ["opencode.json", "opencode.jsonc"],
      },
      t
    );
  },
  async plan(t: InstallTarget): Promise<Change[]> {
    const file = opencodeConfigPath(t);
    const changes: Change[] = [
      {
        kind: "merge-json",
        path: file,
        patch: {
          ...(existsSync(file) ? {} : { $schema: "https://opencode.ai/config.json" }),
          mcp: { ynm: opencodeServerEntry(t.transport) },
        },
        reason: `register the ynm MCP server with OpenCode (${t.scope} scope)`,
      },
    ];
    const agents =
      t.scope === "user"
        ? join(t.home, ".config", "opencode", "AGENTS.md")
        : join(t.cwd, "AGENTS.md");
    const c = delimitedBlockChange(
      agents,
      agentsMdBlock(),
      AGENTS_MD_MARKER,
      "memory guidance for the agent (delimited block in AGENTS.md)"
    );
    if (c) changes.push(c);
    return changes;
  },
  // OpenCode's extension points are plugins, not command hooks, so ynm installs none (ADR-016).
  async status({ cwd, home }): Promise<ClientStatus> {
    const guided =
      hasGuidanceBlock(join(cwd, "AGENTS.md")) ||
      hasGuidanceBlock(join(home, ".config", "opencode", "AGENTS.md"));
    const guidanceFile = [
      join(cwd, "AGENTS.md"),
      join(home, ".config", "opencode", "AGENTS.md"),
    ].find((f) => hasGuidanceBlock(f));
    for (const file of [
      join(cwd, "opencode.json"),
      join(home, ".config", "opencode", "opencode.json"),
    ]) {
      if (!existsSync(file)) continue;
      const cfg = JSON.parse(readFileSync(file, "utf8")) as { mcp?: Record<string, unknown> };
      if (cfg.mcp?.ynm)
        return {
          client: "opencode",
          configured: true,
          detail: file,
          guidance: guided,
          files: [file, ...(guidanceFile ? [guidanceFile] : [])],
        };
    }
    return {
      client: "opencode",
      configured: false,
      detail: "ynm not registered; run `ynm client install opencode`",
      guidance: guided,
      files: guidanceFile ? [guidanceFile] : [],
    };
  },
};
