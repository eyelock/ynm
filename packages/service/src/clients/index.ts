import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { claudeCode } from "./claude-code.js";
import { copilotCli } from "./copilot-cli.js";
import { stringifyLike } from "./json-style.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import type { Change, ClientAdapter, ClientStatus, DetectTarget } from "./types.js";
import { ynh } from "./ynh.js";

export * from "./agents-md.js";
export * from "./claude-code.js";
export * from "./claude-instructions.js";
export * from "./copilot-cli.js";
export * from "./json-style.js";
export * from "./opencode.js";
export * from "./pi.js";
export * from "./types.js";
export * from "./ynh.js";

/** Registry: a new client is one file plus tests (ADR-013). */
export const CLIENT_ADAPTERS: readonly ClientAdapter[] = [
  claudeCode,
  copilotCli,
  opencode,
  pi,
  ynh,
];

export function clientAdapter(name: string): ClientAdapter {
  const a = CLIENT_ADAPTERS.find((c) => c.name === name);
  if (!a)
    throw new Error(
      `unknown client "${name}" (have: ${CLIENT_ADAPTERS.map((c) => c.name).join(", ")})`
    );
  return a;
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
        ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

export interface ClientReport extends ClientStatus {
  detected: boolean;
  /** Which detection signals fired, or why none did. */
  detection: string;
  /**
   * ok: server, guidance and hooks all in place; warn: the server is registered but guidance or
   * hooks are missing; off: ynm is not registered with this client.
   */
  level: "ok" | "warn" | "off";
  /** What to run to close a gap. */
  advice?: string;
}

/** Status of every client plus whether it was detected, graded for `client status` and doctor. */
export async function clientReports(target: DetectTarget): Promise<ClientReport[]> {
  const out: ClientReport[] = [];
  for (const a of CLIENT_ADAPTERS) {
    const d = await a.detect(target);
    const s = await a.status(target);
    const gap = s.configured && (s.guidance === false || s.hooks === false);
    out.push({
      ...s,
      detected: d.installed,
      detection: d.detail,
      level: !s.configured ? "off" : gap ? "warn" : "ok",
      ...(gap
        ? {
            advice: `${[s.guidance === false ? "guidance" : "", s.hooks === false ? "hooks" : ""].filter(Boolean).join(" and ")} missing; run \`ynm client install ${a.name}\``,
          }
        : {}),
    });
  }
  return out;
}

/** One line per client: server, guidance and hooks at a glance. */
export function formatClientReport(r: ClientReport): string {
  if (r.level === "off")
    return `--   ${r.client}: ${r.detected ? `detected (${r.detection}); ${r.detail}` : "not detected"}`;
  const yn = (v: boolean | undefined) => (v === undefined ? "n/a" : v ? "yes" : "no");
  const tag = r.level === "ok" ? "ok  " : "warn";
  return `${tag} ${r.client}: server yes, guidance ${yn(r.guidance)}, hooks ${yn(r.hooks)}; ${r.advice ?? r.detail}`;
}

/** What a change touches, for plans and reports: the path, the command line or the note. */
export function changeTarget(c: Change): string {
  return c.kind === "command" ? c.argv.join(" ") : c.kind === "note" ? c.text : c.path;
}

export interface ApplyOptions {
  /** Runs a command change; defaults to not running (returns the argv for the caller to show). */
  runCommand?: (argv: string[]) => Promise<void>;
}

/** Applies planned changes: file writes and JSON merges directly, commands through the hook. */
export async function applyChanges(changes: Change[], opts: ApplyOptions = {}): Promise<string[]> {
  const done: string[] = [];
  for (const c of changes) {
    if (c.kind === "write") {
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.content);
      done.push(`wrote ${c.path}`);
    } else if (c.kind === "merge-json") {
      const raw = existsSync(c.path) ? readFileSync(c.path, "utf8") : undefined;
      const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, stringifyLike(raw, deepMerge(existing, c.patch)));
      done.push(`merged ${c.path}`);
    } else if (c.kind === "note") {
      done.push(`next: ${c.text}`);
    } else if (opts.runCommand) {
      await opts.runCommand(c.argv);
      done.push(`ran ${c.argv.join(" ")}`);
    } else {
      done.push(`run: ${c.argv.join(" ")}`);
    }
  }
  return done;
}

/** True when applying `c` would leave the file exactly as it is. */
export function changeIsNoop(c: Change): boolean {
  if (c.kind === "write") return existsSync(c.path) && readFileSync(c.path, "utf8") === c.content;
  if (c.kind !== "merge-json" || !existsSync(c.path)) return false;
  try {
    const existing = JSON.parse(readFileSync(c.path, "utf8")) as Record<string, unknown>;
    return JSON.stringify(deepMerge(existing, c.patch)) === JSON.stringify(existing);
  } catch {
    return false;
  }
}

export interface ClientSetup {
  client: string;
  /** Which detection signals fired, or "requested" for a client named with --client. */
  detected: string;
  /** Short names of what was written: `.mcp.json`, `CLAUDE.md`, `3 hooks`. Empty: unchanged. */
  applied: string[];
  /** Steps left for the user: commands, or installs that touch files outside the project. */
  run: string[];
  /**
   * Set when the client is on this machine but the project shows no sign of using it: init
   * writes nothing for it and suggests the install command instead.
   */
  skipped?: "machine-only";
}

export interface ConfigureClientsOptions extends DetectTarget {
  /** Configure exactly these clients, detected or not; default every detected client. */
  only?: string[];
}

/**
 * `ynm init`'s client step (ADR-016): for each detected client (or each named one), plans the
 * project-scope install with stdio, guidance and hooks, and applies the changes that land inside
 * the project. Changes outside it (a user-level config file) and commands are returned as `run`
 * lines, never applied: init touches only the repository. Re-running reports nothing applied.
 */
export async function configureClients(opts: ConfigureClientsOptions): Promise<ClientSetup[]> {
  const adapters = opts.only?.length ? opts.only.map(clientAdapter) : CLIENT_ADAPTERS;
  const root = resolve(opts.cwd);
  const inside = (p: string) => {
    const r = relative(root, resolve(p));
    return r !== "" && !r.startsWith("..") && !isAbsolute(r);
  };
  const out: ClientSetup[] = [];
  for (const a of adapters) {
    const d = await a.detect(opts);
    if (!opts.only?.length) {
      // A ynh harness is configured on purpose (`ynm client install ynh`), never by init: a repo
      // that holds a harness manifest may be a harness product, not a harness to install into.
      if (a.name === "ynh" || !d.installed) continue;
      // Only clients the project already uses get files; one installed on the machine alone is
      // a suggestion, so init never adds a client's config to a repository that doesn't use it.
      if (d.signals && !d.signals.project) {
        out.push({
          client: a.name,
          detected: d.detail,
          applied: [],
          run: [`ynm client install ${a.name}`],
          skipped: "machine-only",
        });
        continue;
      }
    }
    const plan = await a.plan({
      cwd: opts.cwd,
      home: opts.home,
      scope: "project",
      transport: { kind: "stdio", command: "ynm", args: ["serve"] },
      hooks: true,
    });
    const local = plan.filter(
      (c) => (c.kind === "write" || c.kind === "merge-json") && inside(c.path) && !changeIsNoop(c)
    );
    const outside = plan.some(
      (c) => (c.kind === "write" || c.kind === "merge-json") && !inside(c.path) && !changeIsNoop(c)
    );
    const run: string[] = [];
    if (outside) run.push(`ynm client install ${a.name}`);
    const configured = (await a.status(opts)).configured;
    for (const c of plan) {
      if (c.kind === "command" && !configured) run.push(c.argv.join(" "));
      if (c.kind === "note" && local.length) run.push(c.text);
    }
    await applyChanges(local);
    out.push({
      client: a.name,
      detected: opts.only?.length ? (d.installed ? d.detail : "requested") : d.detail,
      applied: local.map((c) =>
        c.kind === "write" || c.kind === "merge-json" ? (c.label ?? relative(root, c.path)) : ""
      ),
      run,
    });
  }
  return out;
}
