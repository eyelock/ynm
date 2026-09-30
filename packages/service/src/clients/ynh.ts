import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guidance } from "@ynm/model";
import type { Change, ClientAdapter, ClientStatus, Detection, InstallTarget } from "./types.js";

export interface YnhPluginOptions {
  version: string;
  transport: InstallTarget["transport"];
}

/** The harness manifest ynh reads; also the checked-in `.ynh-plugin/plugin.json` (ADR-013). */
export function ynhPlugin(opts: YnhPluginOptions): Record<string, unknown> {
  const server =
    opts.transport.kind === "stdio"
      ? { command: opts.transport.command, args: opts.transport.args }
      : {
          url: opts.transport.url,
          ...(opts.transport.bearer
            ? { headers: { Authorization: `Bearer ${opts.transport.bearer}` } }
            : {}),
        };
  return {
    $schema: "https://eyelock.github.io/ynh/schema/plugin.schema.json",
    name: "ynm",
    version: opts.version,
    description: "Your named memory: agent memory in git notes over MCP",
    author: { name: "eyelock", url: "https://github.com/eyelock" },
    keywords: ["memory", "mcp", "git-notes", "agents"],
    default_vendor: "claude",
    mcp_servers: { ynm: server },
    profiles: {
      hosted: { mcp_servers: { ynm: { url: "http://localhost:3000/mcp" } } },
    },
    focuses: {
      recall: {
        prompt:
          "Before answering, call memory_recall with the key terms of my question and use what comes back.",
      },
      remember: {
        prompt:
          "Review this conversation and record, with memory_remember, any decision, preference, procedure or gotcha worth keeping. One memory per fact. Then summarise what you stored.",
      },
    },
    sensors: {
      "memory-context": {
        category: "behaviour",
        source: { command: "ynm context" },
        output: { format: "markdown" },
      },
    },
  };
}

/** The skill ynh installs next to the manifest: the guidance, rendered once. */
export function ynhSkill(): string {
  return `---\nname: ynm-memory\ndescription: Use persistent memory (ynm) deliberately - recall before answering, remember decisions and preferences, supersede rather than duplicate.\n---\n\n${guidance("session-start").trim()}\n\n${guidance("when-to-remember").trim()}\n\n${guidance("when-to-promote").trim()}\n`;
}

export const YNH_SOURCE = "github.com/eyelock/ynm";

/**
 * ynh: the plugin is a checked-in artefact at the ynm repo root, so installation is
 * `ynh install github.com/eyelock/ynm`; this adapter only verifies and offers the command.
 */
export const ynh: ClientAdapter = {
  name: "ynh",
  async detect({ home }): Promise<Detection> {
    const present = existsSync(join(home, ".ynh"));
    return { installed: present, detail: present ? "~/.ynh present" : "ynh not found" };
  },
  async plan(): Promise<Change[]> {
    return [
      {
        kind: "command",
        argv: ["ynh", "install", YNH_SOURCE],
        reason: "install the ynm harness plugin (MCP server, skill, focuses, sensor)",
      },
    ];
  },
  async status({ home }): Promise<ClientStatus> {
    const dir = join(home, ".ynh");
    if (!existsSync(dir)) return { client: "ynh", configured: false, detail: "ynh not installed" };
    const found = findFile(dir, "plugin.json", 4).some((f) => {
      try {
        return (JSON.parse(readFileSync(f, "utf8")) as { name?: string }).name === "ynm";
      } catch {
        return false;
      }
    });
    return {
      client: "ynh",
      configured: found,
      detail: found ? "ynm harness installed" : `run \`ynh install ${YNH_SOURCE}\``,
    };
  },
};

function findFile(dir: string, name: string, depth: number): string[] {
  if (depth < 0) return [];
  const out: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findFile(p, name, depth - 1));
    else if (e.name === name) out.push(p);
  }
  return out;
}
