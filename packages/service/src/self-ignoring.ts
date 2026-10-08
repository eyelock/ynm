import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Makes a derived directory ignore itself in every clone: a `.gitignore` holding `*` inside it
 * ignores the folder's contents, the `.gitignore` included, and changes no file in the
 * repository (the pattern pytest's and ruff's caches use). Written only when missing, so it
 * heals clones whose directory predates it. Failure is not fatal: the directory is derived.
 */
export function ensureSelfIgnoring(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".gitignore");
    if (!existsSync(file)) writeFileSync(file, "*\n");
  } catch {
    // read-only or racing: the .git/info/exclude entries still cover an initialised clone
  }
}
