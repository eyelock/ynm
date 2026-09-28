import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../providers/git-notes/git.js";

const IDENTITY = ["-c", "user.name=ynm-test", "-c", "user.email=test@ynm.local"];

/** Runs git in a fixture repo with a fixed identity. */
export async function fx(cwd: string, ...args: string[]): Promise<string> {
  return (await git([...IDENTITY, ...args], { cwd })).trim();
}

export function tempDir(prefix = "ynm-git-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A work-tree repo with `commits` empty commits on main. */
export async function createRepo(commits = 1): Promise<string> {
  const dir = tempDir();
  await fx(dir, "init", "-q", "-b", "main");
  for (let i = 0; i < commits; i++) await fx(dir, "commit", "-q", "--allow-empty", "-m", `c${i}`);
  return dir;
}

/** A bare repo with one root commit, as `ynm init --bare` produces. */
export async function createBare(): Promise<string> {
  const dir = tempDir("ynm-bare-");
  await fx(dir, "init", "-q", "--bare", "-b", "main");
  const tree = await fx(dir, "mktree");
  const commit = (
    await git([...IDENTITY, "commit-tree", tree, "-m", "ynm: root"], { cwd: dir, input: "" })
  ).trim();
  await fx(dir, "update-ref", "refs/heads/main", commit);
  return dir;
}

export async function clone(source: string): Promise<string> {
  const dir = tempDir("ynm-clone-");
  await fx(dir, "clone", "-q", source, ".");
  return dir;
}

export async function rootCommit(cwd: string): Promise<string> {
  return fx(cwd, "rev-list", "--max-parents=0", "HEAD");
}
