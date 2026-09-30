import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guidance } from "@ynm/model";
import { stringifyLike } from "./json-style.js";
import type { Change, ClientAdapter, ClientStatus, Detection, InstallTarget } from "./types.js";
import { detectBySignals } from "./types.js";

export const YNH_SCHEMA = "https://eyelock.github.io/ynh/schema/plugin.schema.json";

export interface YnhPluginOptions {
  version: string;
  transport: InstallTarget["transport"];
}

/**
 * ynh's canonical hook events and the `ynm hook` command each runs (ADR-016). ynh translates
 * them per vendor: on Claude Code and Codex, `on_session_start` is SessionStart,
 * `before_prompt` is UserPromptSubmit and `on_stop` is Stop.
 */
export const YNH_HOOKS = {
  on_session_start: "ynm hook session-start",
  before_prompt: "ynm hook prompt",
  on_stop: "ynm hook stop",
} as const;

function ynhServer(t: InstallTarget["transport"]): Record<string, unknown> {
  return t.kind === "stdio"
    ? { command: t.command, args: t.args }
    : { url: t.url, ...(t.bearer ? { headers: { Authorization: `Bearer ${t.bearer}` } } : {}) };
}

/** The harness manifest ynh reads; also the checked-in `.ynh-plugin/plugin.json` (ADR-013). */
export function ynhPlugin(opts: YnhPluginOptions): Record<string, unknown> {
  return {
    $schema: YNH_SCHEMA,
    name: "ynm",
    version: opts.version,
    description: "Your named memory: agent memory in git notes over MCP",
    author: { name: "eyelock", url: "https://github.com/eyelock" },
    keywords: ["memory", "mcp", "git-notes", "agents"],
    default_vendor: "claude",
    mcp_servers: { ynm: ynhServer(opts.transport) },
    hooks: Object.fromEntries(
      Object.entries(YNH_HOOKS).map(([event, command]) => [event, [{ command }]])
    ),
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

export const harnessManifestPath = (cwd: string): string => join(cwd, ".ynh-plugin", "plugin.json");
export const harnessSkillPath = (cwd: string): string =>
  join(cwd, "skills", "ynm-memory", "SKILL.md");

/**
 * How a harness gets ynm's guidance: an include of the skill from ynm's repository, resolved and
 * kept current by ynh, the same way a harness pulls any other skill. Nothing is copied into the
 * harness's own `skills/`.
 */
export const SKILL_INCLUDE = {
  git: "https://github.com/eyelock/ynm",
  pick: ["skills/ynm-memory"],
} as const;

function includePresent(m: Manifest): boolean {
  const list = (m as { includes?: unknown }).includes;
  return (
    Array.isArray(list) &&
    list.some((i) => {
      const inc = i as { git?: unknown; pick?: unknown };
      return (
        typeof inc?.git === "string" &&
        /github\.com\/eyelock\/ynm(\.git)?\/?$/.test(inc.git) &&
        (!Array.isArray(inc.pick) || inc.pick.includes("skills/ynm-memory"))
      );
    })
  );
}

type Manifest = Record<string, unknown> & {
  mcp_servers?: Record<string, Record<string, unknown>>;
  hooks?: Record<string, Array<{ command?: string; matcher?: string }>>;
};

function readManifest(cwd: string): Manifest | null {
  try {
    const v = JSON.parse(readFileSync(harnessManifestPath(cwd), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Manifest) : null;
  } catch {
    return null;
  }
}

function hookPresent(m: Manifest, event: string, command: string): boolean {
  const entries = m.hooks?.[event];
  return Array.isArray(entries) && entries.some((h) => h?.command?.trim() === command);
}

/**
 * Merges ynm into the harness in `t.cwd`: the MCP server, the hooks and the skill. Returns the
 * changes (none when everything is already there) plus a note to run `ynd validate .`.
 */
function harnessPlan(t: InstallTarget): Change[] {
  const file = harnessManifestPath(t.cwd);
  const m = readManifest(t.cwd);
  if (!m)
    return [
      {
        kind: "note",
        text: `${file} is not a JSON object; fix it, then rerun \`ynm client install ynh\``,
        reason: "harness manifest unreadable",
      },
    ];
  const changes: Change[] = [];
  const done: string[] = [];
  const next: Manifest = structuredClone(m);
  const want = ynhServer(t.transport);
  const cur = m.mcp_servers?.ynm;
  const same =
    cur &&
    Object.keys(want).every((k) => JSON.stringify(cur[k]) === JSON.stringify(want[k])) &&
    !(t.transport.kind === "stdio" ? "url" in cur : "command" in cur);
  if (!same) {
    const fixed =
      typeof cur?.command === "string" && /\s/.test(cur.command.trim())
        ? ` (replaced the string-form command "${cur.command}" with command and args)`
        : "";
    const env = cur?.env ? { env: cur.env } : {};
    next.mcp_servers = { ...(m.mcp_servers ?? {}), ynm: { ...want, ...env } };
    done.push(`mcp_servers.ynm${fixed}`);
  }
  let included = false;
  if (!includePresent(m)) {
    const list = (m as { includes?: unknown }).includes;
    (next as { includes?: unknown[] }).includes = [
      ...(Array.isArray(list) ? list : []),
      { ...SKILL_INCLUDE, pick: [...SKILL_INCLUDE.pick] },
    ];
    done.push("include of the ynm-memory skill");
    included = true;
  }
  let hookCount = 0;
  if (t.hooks !== false) {
    const added: string[] = [];
    for (const [event, command] of Object.entries(YNH_HOOKS)) {
      if (hookPresent(m, event, command)) continue;
      const hooks = { ...(next.hooks ?? {}) };
      hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), { command }];
      next.hooks = hooks;
      added.push(event);
    }
    if (added.length) {
      done.push(`hooks ${added.join(", ")}`);
      hookCount = added.length;
    }
  }
  // `ynd validate` requires the schema reference; a hand-made manifest often lacks it.
  const withSchema = next.$schema ? next : { $schema: YNH_SCHEMA, ...next };
  if (!next.$schema) done.push("$schema");
  if (done.length)
    changes.push({
      kind: "write",
      path: file,
      content: stringifyLike(readFileSync(file, "utf8"), withSchema),
      reason: `harness manifest: ${done.join("; ")}`,
      label: `harness manifest${included ? ", skill include" : ""}${hookCount ? `, ${hookCount} hook${hookCount === 1 ? "" : "s"}` : ""}`,
    });
  if (changes.length)
    changes.push({
      kind: "note",
      text: "ynm validate",
      reason: "check every piece ynm set up in the harness",
    });
  return changes;
}

/**
 * ynh: in a harness (the cwd holds `.ynh-plugin/plugin.json`) the adapter merges ynm's server,
 * hooks and skill into it. Elsewhere it offers `ynh install github.com/eyelock/ynm`, which
 * installs ynm's own checked-in harness.
 */
export const ynh: ClientAdapter = {
  name: "ynh",
  async detect(t): Promise<Detection> {
    return detectBySignals(
      { bin: "ynh", user: [".ynh"], project: [join(".ynh-plugin", "plugin.json")] },
      t
    );
  },
  async plan(t: InstallTarget): Promise<Change[]> {
    if (existsSync(harnessManifestPath(t.cwd))) return harnessPlan(t);
    return [
      {
        kind: "command",
        argv: ["ynh", "install", YNH_SOURCE],
        reason: "install the ynm harness plugin (MCP server, hooks, skill, focuses, sensor)",
      },
    ];
  },
  async status({ cwd, home }): Promise<ClientStatus> {
    if (existsSync(harnessManifestPath(cwd))) {
      const m = readManifest(cwd) ?? {};
      const server = !!(m as Manifest).mcp_servers?.ynm;
      const guided = includePresent(m as Manifest) || existsSync(harnessSkillPath(cwd));
      const hooked = Object.entries(YNH_HOOKS).every(([e, c]) => hookPresent(m as Manifest, e, c));
      const file = harnessManifestPath(cwd);
      const srv = (m as Manifest).mcp_servers?.ynm;
      const hookNames = Object.entries(YNH_HOOKS).filter(([e, c]) =>
        hookPresent(m as Manifest, e, c)
      );
      return {
        client: "ynh",
        configured: server,
        detail: server
          ? `harness ${file}`
          : "harness here; ynm not declared; run `ynm client install ynh`",
        guidance: guided,
        hooks: hooked,
        checked: [
          `manifest  ${file}`,
          `server    ${srv ? `mcp_servers.ynm runs \`${[srv.command, ...((srv.args as string[] | undefined) ?? [])].filter(Boolean).join(" ") || srv.url}\`` : "missing"}`,
          `guidance  ${includePresent(m as Manifest) ? `includes ${SKILL_INCLUDE.git} ${SKILL_INCLUDE.pick.join(", ")}` : existsSync(harnessSkillPath(cwd)) ? harnessSkillPath(cwd) : "missing"}`,
          `hooks     ${hookNames.length ? hookNames.map(([e, c]) => `${e} runs \`${c}\``).join("; ") : "missing"}`,
        ],
      };
    }
    const dir = join(home, ".ynh");
    if (!existsSync(dir)) return { client: "ynh", configured: false, detail: "ynh not installed" };
    const found = findFile(dir, "plugin.json", 4).find((f) => {
      try {
        return (JSON.parse(readFileSync(f, "utf8")) as { name?: string }).name === "ynm";
      } catch {
        return false;
      }
    });
    if (!found)
      return { client: "ynh", configured: false, detail: `run \`ynh install ${YNH_SOURCE}\`` };
    const harness = join(found, "..", "..");
    const m = readManifest(harness) ?? {};
    const guided = existsSync(harnessSkillPath(harness));
    const hooked = Object.entries(YNH_HOOKS).every(([e, c]) => hookPresent(m as Manifest, e, c));
    return {
      client: "ynh",
      configured: true,
      detail: `ynm harness installed${hooked ? "" : `; hooks missing (an older release: run \`ynh update ynm\`)`}`,
      guidance: guided,
      hooks: hooked,
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
