import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeCode } from "./claude-code.js";
import { copilotCli } from "./copilot-cli.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import type { Change, ClientAdapter, ClientStatus, InstallTarget } from "./types.js";
import { ynh } from "./ynh.js";

export * from "./agents-md.js";
export * from "./claude-code.js";
export * from "./copilot-cli.js";
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
export async function clientReports(
  target: Pick<InstallTarget, "cwd" | "home">
): Promise<ClientReport[]> {
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
      const existing = existsSync(c.path)
        ? (JSON.parse(readFileSync(c.path, "utf8")) as Record<string, unknown>)
        : {};
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, `${JSON.stringify(deepMerge(existing, c.patch), null, 2)}\n`);
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
