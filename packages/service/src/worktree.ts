import { resolve } from "node:path";
import { gitOrNull } from "@ynm/store";

/** Copied from ACME's worktree detector, using argv arrays instead of a shell string. */
export interface WorktreeInfo {
  isGitRepo: boolean;
  isWorktree: boolean;
  isBare: boolean;
  /** Main repository work tree, or the bare repo path. */
  mainRepoPath: string;
  currentPath: string;
  gitCommonDir: string;
  gitDir: string;
}

export async function detectWorktree(cwd: string = process.cwd()): Promise<WorktreeInfo> {
  const gitDir = (
    await gitOrNull(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd })
  )?.trim();
  if (!gitDir) {
    return {
      isGitRepo: false,
      isWorktree: false,
      isBare: false,
      mainRepoPath: cwd,
      currentPath: cwd,
      gitCommonDir: "",
      gitDir: "",
    };
  }
  const commonDir =
    (
      await gitOrNull(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
    )?.trim() ?? gitDir;
  const bare = (await gitOrNull(["rev-parse", "--is-bare-repository"], { cwd }))?.trim() === "true";
  const toplevel = bare
    ? commonDir
    : ((await gitOrNull(["rev-parse", "--show-toplevel"], { cwd }))?.trim() ?? cwd);
  const isWorktree = resolve(gitDir) !== resolve(commonDir);
  const mainRepoPath = bare ? commonDir : resolve(commonDir, "..");
  return {
    isGitRepo: true,
    isWorktree,
    isBare: bare,
    mainRepoPath,
    currentPath: toplevel,
    gitCommonDir: resolve(commonDir),
    gitDir: resolve(gitDir),
  };
}
