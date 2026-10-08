import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { stringifyLike } from "./json-style.js";
import { SKILLS_PATH, ynmSkill } from "./skill.js";
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

/**
 * The environment ynh's worker keeps. ynh filters a worker's environment to the manifest's
 * top-level `env_passthrough` plus a process minimum, so without these the MCP server and hooks
 * lose the settings that choose the store and the person and silently fall back to `~/.ynm`, the
 * user's real personal store. These are the `YNM_*` variables that select the store, the identity
 * or the configuration. Not here: API keys (ynm loads those from `$YNM_HOME/env` itself),
 * `YNM_STORE` (names the bare repository only the container image serves), and the telemetry
 * variables (`OTEL_*`, `YNR_SPOOL`), which change where spans go, not which store is used; ynh
 * supplies `YNR_SPOOL` itself when its telemetry is on.
 */
export const YNH_ENV_PASSTHROUGH = [
  "YNM_HOME",
  "YNM_USER",
  "YNM_ACTOR",
  "YNM_ANCHOR",
  "YNM_REMOTE",
  "YNM_PROVIDER",
  "YNM_PERSONAL_STORE",
  "YNM_INDEX",
  "YNM_MOUNTS",
] as const;

/** Set by ynh in an agent worker's environment (`ynh agent run`); absent in an interactive run. */
export const YNH_WORKER_SIGNAL = "YNH_AGENT_SESSION";

function ynhServer(t: InstallTarget["transport"]): Record<string, unknown> {
  return t.kind === "stdio"
    ? { command: t.command, args: t.args }
    : { url: t.url, ...(t.bearer ? { headers: { Authorization: `Bearer ${t.bearer}` } } : {}) };
}

/** The harness manifest ynh reads; also the checked-in `.agents/harness/plugin.json` (ADR-013). */
export function ynhPlugin(opts: YnhPluginOptions): Record<string, unknown> {
  return {
    $schema: YNH_SCHEMA,
    name: "ynm",
    version: opts.version,
    description: "Your named memory: agent memory in git notes over MCP",
    author: { name: "eyelock", url: "https://github.com/eyelock" },
    keywords: ["memory", "mcp", "git-notes", "agents"],
    default_vendor: "claude",
    includes: [{ ...SKILL_INCLUDE, pick: [...SKILL_INCLUDE.pick] }],
    env_passthrough: [...YNH_ENV_PASSTHROUGH],
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
/** The skill ynh gets is ynm's one skill (skill.ts), included from `integrations/skills`. */
export const ynhSkill = ynmSkill;

export const YNH_SOURCE = "github.com/eyelock/ynm";

/** ynh's canonical manifest location: `.agents/harness/plugin.json`. */
export const HARNESS_DIR = join(".agents", "harness");
export const canonicalManifestPath = (cwd: string): string => join(cwd, HARNESS_DIR, "plugin.json");
/** The deprecated location ynh still reads as a fallback; ynm never writes it. */
export const LEGACY_HARNESS_DIR = ".ynh-plugin";
export const legacyManifestPath = (cwd: string): string =>
  join(cwd, LEGACY_HARNESS_DIR, "plugin.json");
/** The manifest that is there: the canonical one, else the legacy one; canonical when neither. */
export const harnessManifestPath = (cwd: string): string =>
  !existsSync(canonicalManifestPath(cwd)) && existsSync(legacyManifestPath(cwd))
    ? legacyManifestPath(cwd)
    : canonicalManifestPath(cwd);
export const harnessSkillPath = (cwd: string): string =>
  join(cwd, "skills", "ynm-memory", "SKILL.md");

/**
 * How a harness gets ynm's guidance: an include of the skill from ynm's repository, resolved and
 * kept current by ynh, the same way a harness pulls any other skill. Nothing is copied into the
 * harness's own `skills/`.
 */
/** Where ynm's ynh harness lives in its repository (`ynh install ... --path`, include `path`). */
export const YNH_PATH = "integrations/ynh";

export const SKILL_INCLUDE = {
  git: "https://github.com/eyelock/ynm",
  path: SKILLS_PATH,
  pick: ["skills/ynm-memory"],
} as const;

/** An include entry that points at ynm's repository, current or from before the harness moved. */
function isYnmInclude(i: unknown): boolean {
  const inc = i as { git?: unknown };
  return typeof inc?.git === "string" && /github\.com\/eyelock\/ynm(\.git)?\/?$/.test(inc.git);
}

function includePresent(m: Manifest): boolean {
  const list = (m as { includes?: unknown }).includes;
  return (
    Array.isArray(list) &&
    list.some((i) => {
      const inc = i as { path?: unknown; pick?: unknown };
      return (
        isYnmInclude(i) &&
        inc.path === SKILLS_PATH &&
        (!Array.isArray(inc.pick) || inc.pick.includes("skills/ynm-memory"))
      );
    })
  );
}

type Manifest = Record<string, unknown> & {
  env_passthrough?: unknown;
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

/** Whether the harness lets `YNM_HOME` reach the worker; without it ynm uses `~/.ynm`. */
function envPassed(m: Manifest): boolean {
  return Array.isArray(m.env_passthrough) && m.env_passthrough.includes("YNM_HOME");
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
  const found = harnessManifestPath(t.cwd);
  const file = canonicalManifestPath(t.cwd);
  const m = readManifest(t.cwd);
  if (!m)
    return [
      {
        kind: "note",
        text: `${found} is not a JSON object; fix it, then rerun \`ynm client install ynh\``,
        reason: "harness manifest unreadable",
      },
    ];
  const changes: Change[] = [];
  const done: string[] = [];
  // Only the legacy manifest exists: move it to ynh's layout (as `ynd migrate` does) so there is
  // never a second manifest to drift from it.
  const legacy = found !== file;
  if (legacy) {
    const wholeDir = !existsSync(join(t.cwd, HARNESS_DIR));
    changes.push({
      kind: "move",
      from: wholeDir ? join(t.cwd, LEGACY_HARNESS_DIR) : found,
      to: wholeDir ? join(t.cwd, HARNESS_DIR) : file,
      reason: `${LEGACY_HARNESS_DIR}/ is deprecated; moved to ynh's ${HARNESS_DIR}${sep}`,
      label: `moved ${LEGACY_HARNESS_DIR}/ to ${HARNESS_DIR}/`,
    });
    done.push(`moved from ${LEGACY_HARNESS_DIR}/`);
  }
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
    // An older ynm include (from before the harness moved to integrations/ynh) is replaced in
    // place, not duplicated.
    const others = Array.isArray(list) ? list.filter((i) => !isYnmInclude(i)) : [];
    const replaced = Array.isArray(list) && others.length < list.length;
    (next as { includes?: unknown[] }).includes = [
      ...others,
      { ...SKILL_INCLUDE, pick: [...SKILL_INCLUDE.pick] },
    ];
    done.push(
      replaced
        ? `include of the ynm-memory skill (updated to ${SKILLS_PATH})`
        : "include of the ynm-memory skill"
    );
    included = true;
  }
  // Merge ynm's variables into the harness's own allowlist: keep what is there, add what is not.
  const have = Array.isArray(m.env_passthrough) ? (m.env_passthrough as unknown[]) : [];
  const lacking = YNH_ENV_PASSTHROUGH.filter((v) => !have.includes(v));
  if (lacking.length) {
    next.env_passthrough = [...have, ...lacking];
    done.push("env_passthrough");
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
      content: stringifyLike(readFileSync(found, "utf8"), withSchema),
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
 * ynh: in a harness (the cwd holds `.agents/harness/plugin.json`, or the deprecated `.ynh-plugin/plugin.json`, which is moved) the adapter merges ynm's server,
 * hooks and skill into it. Elsewhere it offers `ynh install github.com/eyelock/ynm`, which
 * installs ynm's own checked-in harness.
 */
export const ynh: ClientAdapter = {
  name: "ynh",
  async detect(t): Promise<Detection> {
    return detectBySignals(
      {
        bin: "ynh",
        user: [".ynh"],
        project: [join(HARNESS_DIR, "plugin.json"), join(LEGACY_HARNESS_DIR, "plugin.json")],
      },
      t
    );
  },
  async plan(t: InstallTarget): Promise<Change[]> {
    if (existsSync(harnessManifestPath(t.cwd))) return harnessPlan(t);
    return [
      {
        kind: "command",
        argv: ["ynh", "install", YNH_SOURCE, "--path", YNH_PATH],
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
      const passed = envPassed(m as Manifest);
      return {
        client: "ynh",
        configured: server,
        detail: server
          ? `harness ${file}${file === legacyManifestPath(cwd) ? " (deprecated location; run `ynm client install ynh` to move it to .agents/harness/)" : ""}`
          : "harness here; ynm not declared; run `ynm client install ynh`",
        guidance: guided,
        hooks: hooked,
        env: passed,
        checked: [
          `manifest  ${file}`,
          `server    ${srv ? `mcp_servers.ynm runs \`${[srv.command, ...((srv.args as string[] | undefined) ?? [])].filter(Boolean).join(" ") || srv.url}\`` : "missing"}`,
          `guidance  ${includePresent(m as Manifest) ? `includes ${SKILL_INCLUDE.git} path ${SKILL_INCLUDE.path} pick ${SKILL_INCLUDE.pick.join(", ")}` : existsSync(harnessSkillPath(cwd)) ? harnessSkillPath(cwd) : "missing"}`,
          `env       ${passed ? "env_passthrough carries YNM_HOME" : "env_passthrough lacks YNM_HOME: ynh would hide it from the worker, and ynm would use ~/.ynm"}`,
          `hooks     ${hookNames.length ? hookNames.map(([e, c]) => `${e} runs \`${c}\``).join("; ") : "missing"}`,
        ],
      };
    }
    const dir = join(home, ".ynh");
    if (!existsSync(dir)) return { client: "ynh", configured: false, detail: "ynh not installed" };
    const found = findFile(dir, "plugin.json", 5).find((f) => {
      try {
        return (JSON.parse(readFileSync(f, "utf8")) as { name?: string }).name === "ynm";
      } catch {
        return false;
      }
    });
    if (!found)
      return {
        client: "ynh",
        configured: false,
        detail: `run \`ynh install ${YNH_SOURCE} --path ${YNH_PATH}\``,
      };
    const harness = join(found, "..", "..");
    const m = readManifest(harness) ?? {};
    const guided = includePresent(m as Manifest) || existsSync(harnessSkillPath(harness));
    const hooked = Object.entries(YNH_HOOKS).every(([e, c]) => hookPresent(m as Manifest, e, c));
    return {
      client: "ynh",
      configured: true,
      detail: `ynm harness installed${hooked ? "" : `; hooks missing (an older release: run \`ynh update ynm\`)`}`,
      guidance: guided,
      hooks: hooked,
      env: envPassed(m as Manifest),
      fix: `run \`ynh update ynm\`, or reinstall with \`ynh install ${YNH_SOURCE} --path ${YNH_PATH}\``,
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
