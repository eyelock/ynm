import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { guidance } from "@ynm/model";
import { delimitedBlockChange } from "./agents-md.js";
import { claudeHasGuidance, claudeInstructions } from "./claude-instructions.js";
import type { Change, ClientAdapter, ClientStatus, Detection, InstallTarget } from "./types.js";
import { detectBySignals, stdioServerEntry } from "./types.js";

export const CLAUDE_MD_MARKER = "<!-- ynm:guidance -->";

/** The block appended to CLAUDE.md, delimited so re-installs replace rather than duplicate it. */
export function claudeMdBlock(): string {
  return `${CLAUDE_MD_MARKER}\n${guidance("session-start").trim()}\n${CLAUDE_MD_MARKER}\n`;
}

/** Claude Code's hook events and the `ynm hook` command each runs (ADR-016). */
export const CLAUDE_HOOKS = {
  SessionStart: "ynm hook session-start",
  UserPromptSubmit: "ynm hook prompt",
  Stop: "ynm hook stop",
} as const;

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function eventGroups(settings: Record<string, unknown>, event: string): HookGroup[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.[event];
  return Array.isArray(groups) ? (groups as HookGroup[]) : [];
}

function hasCommand(groups: HookGroup[], command: string): boolean {
  return groups.some((g) => (g.hooks ?? []).some((h) => h.command?.trim() === command));
}

/** Which of ynm's hooks a Claude Code settings file already has, by event. */
export function claudeHooksPresent(file: string): Record<keyof typeof CLAUDE_HOOKS, boolean> {
  const settings = readJson(file);
  return Object.fromEntries(
    Object.entries(CLAUDE_HOOKS).map(([event, command]) => [
      event,
      hasCommand(eventGroups(settings, event), command),
    ])
  ) as Record<keyof typeof CLAUDE_HOOKS, boolean>;
}

/**
 * A merge that adds ynm's hooks to a Claude Code settings file, keeping every other hook and
 * key; an event whose ynm command is already present (in any group) is left alone. Null when
 * nothing is missing. Each event's array is written whole, since the JSON merge replaces arrays.
 */
export function claudeHooksChange(file: string, reason: string): Change | null {
  const settings = readJson(file);
  const patch: Record<string, HookGroup[]> = {};
  for (const [event, command] of Object.entries(CLAUDE_HOOKS)) {
    const groups = eventGroups(settings, event);
    if (hasCommand(groups, command)) continue;
    patch[event] = [...groups, { hooks: [{ type: "command", command }] }];
  }
  if (!Object.keys(patch).length) return null;
  const n = Object.keys(patch).length;
  return {
    kind: "merge-json",
    path: file,
    patch: { hooks: patch },
    reason,
    label: `${n} hook${n === 1 ? "" : "s"}`,
  };
}

/**
 * Where the hooks go: the user's settings for user scope; for a project, Claude Code's personal
 * project file `.claude/settings.local.json`, never the team's tracked `.claude/settings.json`,
 * because a hook that runs `ynm` fails for every teammate who does not have it.
 */
export function claudeSettingsPath(t: Pick<InstallTarget, "cwd" | "home" | "scope">): string {
  return t.scope === "user"
    ? join(t.home, ".claude", "settings.json")
    : join(t.cwd, ".claude", "settings.local.json");
}

/**
 * Claude Code: project scope writes `.mcp.json` (mcpServers), a delimited block in CLAUDE.md
 * and the hooks in `.claude/settings.local.json`; user scope goes through `claude mcp add` so the
 * user's own server config is not hand-edited, and merges the hooks into
 * `~/.claude/settings.json` (Claude Code has no command for hooks).
 */
export const claudeCode: ClientAdapter = {
  name: "claude-code",
  async detect(t): Promise<Detection> {
    return detectBySignals(
      { bin: "claude", user: [".claude", ".claude.json"], project: [".mcp.json", ".claude"] },
      t
    );
  },
  async plan(t: InstallTarget): Promise<Change[]> {
    const changes: Change[] = [];
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
      changes.push({
        kind: "command",
        argv,
        reason: "register ynm with Claude Code for this user",
      });
    } else {
      changes.push({
        kind: "merge-json",
        path: join(t.cwd, ".mcp.json"),
        patch: { mcpServers: { ynm: stdioServerEntry(t.transport) } },
        reason: "register the ynm MCP server for this project",
      });
      // Guidance goes where Claude Code will read it (its own lookup rules), appended to a file
      // that exists; a file is created only when Claude reads nothing in this project.
      if (!claudeHasGuidance(t.cwd, t.home, CLAUDE_MD_MARKER)) {
        const { target } = claudeInstructions(t.cwd, t.home);
        const c = delimitedBlockChange(
          target.path,
          claudeMdBlock(),
          CLAUDE_MD_MARKER,
          "memory guidance for the agent (delimited block)"
        );
        if (c?.kind === "write") changes.push({ ...c, label: relative(t.cwd, target.path) });
      }
    }
    if (t.hooks !== false) {
      const c = claudeHooksChange(
        claudeSettingsPath(t),
        "agent hooks: context at session start, a remember nudge per prompt, session end per turn"
      );
      if (c) changes.push(c);
    }
    return changes;
  },
  async status({ cwd, home }): Promise<ClientStatus> {
    // Any instruction file Claude Code loads here at launch, by its own lookup rules.
    const guided = claudeHasGuidance(cwd, home, CLAUDE_MD_MARKER);
    // A team may also have put them in the shared settings on purpose; any of the three counts.
    const hookFiles = [
      claudeSettingsPath({ cwd, home, scope: "project" }),
      join(cwd, ".claude", "settings.json"),
      claudeSettingsPath({ cwd, home, scope: "user" }),
    ];
    const hooked = Object.keys(CLAUDE_HOOKS).every((event) =>
      hookFiles.some((f) => claudeHooksPresent(f)[event as keyof typeof CLAUDE_HOOKS])
    );
    const file = join(cwd, ".mcp.json");
    const cfg = readJson(file) as { mcpServers?: Record<string, unknown> };
    if (cfg.mcpServers?.ynm)
      return {
        client: "claude-code",
        configured: true,
        detail: `project scope: ${file}`,
        guidance: guided,
        hooks: hooked,
      };
    const userFile = join(home, ".claude.json");
    if (existsSync(userFile) && /"ynm"\s*:/.test(readFileSync(userFile, "utf8")))
      return {
        client: "claude-code",
        configured: true,
        detail: `user scope: ${userFile}`,
        guidance: guided,
        hooks: hooked,
      };
    return {
      client: "claude-code",
      configured: false,
      detail: "ynm not registered; run `ynm client install claude-code`",
      guidance: guided,
      hooks: hooked,
    };
  },
};
