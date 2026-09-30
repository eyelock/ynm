import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Claude Code's instruction-file lookup (code.claude.com/docs/en/memory, v2.1.277+, default
 * "Project instructions" setting): at launch it loads, from the working directory and every
 * directory above it, `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`; only when none of
 * those exist on that path does it load `AGENTS.md` and `.claude/AGENTS.md` instead. A
 * `CLAUDE.md` that imports `@AGENTS.md` pulls it in either way. `~/.claude/CLAUDE.md` always
 * loads and does not count against `AGENTS.md`.
 *
 * ynm uses it to put its guidance where Claude will read it, in a file that already exists,
 * and to create a file only when there is nothing to append to.
 */

const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const AGENTS_FILES = ["AGENTS.md", join(".claude", "AGENTS.md")];

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = resolve(dir);
  for (;;) {
    out.push(d);
    const up = dirname(d);
    if (up === d) return out;
    d = up;
  }
}

function existing(dir: string, names: string[]): string[] {
  return names.map((n) => join(dir, n)).filter((f) => existsSync(f));
}

/** True when `file` has an `@AGENTS.md` import (outside code spans), resolved next to it. */
function importsAgents(file: string): string | null {
  const text = readFileSync(file, "utf8")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");
  if (!/(^|\s)@(\.\/)?AGENTS\.md(\s|$)/m.test(text)) return null;
  const target = join(dirname(file), "AGENTS.md");
  return existsSync(target) ? target : null;
}

export interface ClaudeInstructions {
  /** Which set Claude reads at launch: CLAUDE.md files, or AGENTS.md files. */
  mode: "claude-md" | "agents-md";
  /** Every instruction file Claude loads at launch from `cwd`, user file included. */
  loaded: string[];
  /**
   * Where ynm's guidance block belongs: the file in `cwd` Claude reads, preferring one that
   * exists; `create` is true only when nothing in `cwd` can take it.
   */
  target: { path: string; create: boolean };
}

export function claudeInstructions(cwd: string, home: string): ClaudeInstructions {
  const dirs = ancestors(cwd);
  const claude = dirs.flatMap((d) => existing(d, CLAUDE_FILES));
  const user = join(home, ".claude", "CLAUDE.md");
  const userFiles = existsSync(user) ? [user] : [];
  const project = claude.filter((f) => f !== user);
  if (project.length) {
    const imported = project.map(importsAgents).filter((f): f is string => !!f);
    const loaded = [...userFiles, ...project, ...imported];
    // In cwd: an imported AGENTS.md serves every client; else the CLAUDE file that is there.
    const here = existing(cwd, CLAUDE_FILES);
    const viaImport = here.map(importsAgents).find((f) => !!f);
    const target = viaImport
      ? { path: viaImport, create: false }
      : here.length
        ? { path: here[0] as string, create: false }
        : { path: join(cwd, "CLAUDE.md"), create: true };
    return { mode: "claude-md", loaded, target };
  }
  const agents = dirs.flatMap((d) => existing(d, AGENTS_FILES));
  const hereAgents = existing(cwd, AGENTS_FILES);
  return {
    mode: "agents-md",
    loaded: [...userFiles, ...agents],
    target: hereAgents.length
      ? { path: hereAgents[0] as string, create: false }
      : { path: join(cwd, "AGENTS.md"), create: true },
  };
}

/** True when a file Claude loads at launch from `cwd` already carries `marker`. */
export function claudeHasGuidance(cwd: string, home: string, marker: string): boolean {
  return claudeInstructions(cwd, home).loaded.some((f) => readFileSync(f, "utf8").includes(marker));
}
