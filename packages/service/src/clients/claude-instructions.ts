import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Claude Code's instruction-file lookup (code.claude.com/docs/en/memory, v2.1.277+, default
 * "Project instructions" setting): at launch it loads, from the working directory and every
 * directory above it, `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`; only when none of
 * those exist on that path does it fall back to `AGENTS.md` and `.claude/AGENTS.md`. A
 * `CLAUDE.md` that imports `@AGENTS.md` pulls it in either way. `~/.claude/CLAUDE.md` always
 * loads and does not count against `AGENTS.md`.
 *
 * ynm does not rely on that fallback: Claude Code reliably reads CLAUDE.md. It puts its guidance
 * in a file that exists and that Claude reads; a project with no instruction file gets a new
 * CLAUDE.md; a project with only an AGENTS.md (shared with other clients) keeps the block there
 * and gets a CLAUDE.md that just imports it.
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
  /** Every instruction file Claude loads at launch from `cwd`, user file included. */
  loaded: string[];
  /**
   * Where ynm's guidance block belongs: the file in `cwd` Claude reads, preferring one that
   * exists; `create` is true only when nothing in `cwd` can take it.
   */
  target: { path: string; create: boolean };
  /**
   * Set when `target` is an AGENTS.md that no CLAUDE file imports: the CLAUDE.md to create next
   * to it, holding only `@AGENTS.md`, so Claude reads the block without ynm relying on its
   * AGENTS.md fallback.
   */
  link?: string;
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
    return { loaded, target };
  }
  // No CLAUDE file on the path. An AGENTS.md next to the project stays the shared home of the
  // block, and a CLAUDE.md that imports it is what Claude reads; with neither, CLAUDE.md is new.
  const hereAgents = existing(cwd, AGENTS_FILES)[0];
  if (hereAgents)
    return {
      loaded: userFiles,
      target: { path: hereAgents, create: false },
      link: join(dirname(hereAgents), "CLAUDE.md"),
    };
  return { loaded: userFiles, target: { path: join(cwd, "CLAUDE.md"), create: true } };
}

/** True when a file Claude loads at launch from `cwd` already carries `marker`. */
export function claudeHasGuidance(cwd: string, home: string, marker: string): boolean {
  return claudeInstructions(cwd, home).loaded.some((f) => readFileSync(f, "utf8").includes(marker));
}
