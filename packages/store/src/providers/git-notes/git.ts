import { spawn } from "node:child_process";

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly code: number | string | null
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Counts spawned git processes; tests prove reads are batched, not per shard. */
export const gitStats = { spawned: 0 };

/**
 * Runs git with an argv array (no shell) and optional stdin content, which is closed after
 * writing so stdin-reading plumbing (mktree, hash-object, cat-file --batch) terminates.
 * Copied in spirit from ACME's hardened plumbing, made async.
 */
export function git(args: readonly string[], opts: GitOptions): Promise<string> {
  gitStats.spawned += 1;
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      total += d.length;
      if (total > MAX_BUFFER) child.kill("SIGKILL");
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GitError(args, e.message, "ENOENT"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new GitError(args, Buffer.concat(err).toString("utf8"), code ?? signal));
    });
    child.stdin.on("error", () => {
      // git may exit before reading all of stdin; the close handler reports the real outcome
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Like git() but returns null instead of throwing when the command fails. */
export async function gitOrNull(args: readonly string[], opts: GitOptions): Promise<string | null> {
  try {
    return await git(args, opts);
  } catch {
    return null;
  }
}

/** Commit identity fallback so plumbing works in CI containers without user config. */
export async function identityEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const email = (await gitOrNull(["config", "user.email"], { cwd }))?.trim();
  if (email) return {};
  return {
    GIT_AUTHOR_NAME: "ynm",
    GIT_AUTHOR_EMAIL: "ynm@localhost",
    GIT_COMMITTER_NAME: "ynm",
    GIT_COMMITTER_EMAIL: "ynm@localhost",
  };
}

export const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function assertSha(sha: string): void {
  if (!SHA_PATTERN.test(sha)) throw new Error(`not an object id: ${sha}`);
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const out = (
    await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
  ).trim();
  return out;
}
