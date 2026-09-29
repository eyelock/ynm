import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeCode } from "./claude-code.js";
import type { Change, ClientAdapter } from "./types.js";
import { ynh } from "./ynh.js";

export * from "./claude-code.js";
export * from "./types.js";
export * from "./ynh.js";

/** Registry: a new client is one file plus tests (ADR-013). */
export const CLIENT_ADAPTERS: readonly ClientAdapter[] = [claudeCode, ynh];

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
    } else if (opts.runCommand) {
      await opts.runCommand(c.argv);
      done.push(`ran ${c.argv.join(" ")}`);
    } else {
      done.push(`run: ${c.argv.join(" ")}`);
    }
  }
  return done;
}
