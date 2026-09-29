import { loadConfig, ynmHome } from "./config.js";
import { defaultIndexLocator, IndexManager } from "./indexing.js";
import { openMounts } from "./mounts.js";
import { detectWorktree } from "./worktree.js";
import { Ynm } from "./ynm.js";

export interface OpenOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  noPersonal?: boolean;
  actor?: string;
}

/** Everything a CLI command or MCP tool needs, from a working directory. */
export async function openYnm(opts: OpenOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const worktree = await detectWorktree(cwd);
  const loaded = loadConfig(
    {
      home: ynmHome(env),
      repo: worktree.isGitRepo ? worktree.mainRepoPath : undefined,
      worktree: worktree.isGitRepo ? worktree.currentPath : undefined,
    },
    env
  );
  const mounts = await openMounts({ loaded, worktree, noPersonal: opts.noPersonal });
  const index = new IndexManager(
    loaded.config.index,
    defaultIndexLocator(loaded.home, worktree.isGitRepo ? worktree.mainRepoPath : undefined)
  );
  const ynm = new Ynm({
    mounts,
    actor: opts.actor ?? (loaded.config.actor as string),
    userId: loaded.config.userId as string,
    redaction: loaded.config.redaction,
    index,
  });
  return { ynm, loaded, worktree, mounts, index };
}
