import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRootCommit,
  findRootCommit,
  git,
  gitOrNull,
  identityEnv,
  NOTES_PREFIX,
  REMOTE_PREFIX,
  selectAnchor,
} from "@ynm/store";
import { ensurePersonalStore } from "./personal-store.js";
import { detectWorktree } from "./worktree.js";

export interface InitProjectOptions {
  cwd: string;
  remote?: string;
  hooks?: boolean;
  anchor?: string;
}

export interface InitReport {
  repo: string;
  anchor: string;
  anchorSource: string;
  configFile: string;
  configWritten: boolean;
  refspecs: string[];
  hooksInstalled: string[];
  notes: string[];
}

export const SHARED_FETCH = (remote: string): string =>
  `+${NOTES_PREFIX}/shared/*:${REMOTE_PREFIX}/${remote}/shared/*`;
export const SHARED_PUSH = `${NOTES_PREFIX}/shared/*:${NOTES_PREFIX}/shared/*`;

const PRE_PUSH_HOOK = `#!/bin/sh
# ynm: sync shared memory notes alongside code pushes (installed by \`ynm init\`)
[ -n "$YNM_SYNC_IN_PROGRESS" ] && exit 0
command -v ynm >/dev/null 2>&1 && ynm sync --quiet || true
exit 0
`;

/**
 * Retrofits a repository (ADR-009): no branch, tag or tracked file changes. Writes
 * .ynm/config.json with the anchor, adds shared-only refspecs and a pre-push hook.
 */
export async function initProject(opts: InitProjectOptions): Promise<InitReport> {
  const wt = await detectWorktree(opts.cwd);
  if (!wt.isGitRepo) throw new Error(`${opts.cwd} is not inside a git repository`);
  const repo = wt.mainRepoPath;
  const env = await identityEnv(repo);
  const notes: string[] = [];
  const anchor = await selectAnchor(repo, { configured: opts.anchor, create: true, env });
  if (anchor.source === "created")
    notes.push("repository had no commits; created an empty root commit as the anchor");
  if (!anchor.present)
    notes.push("anchor object is not present locally (shallow clone); reads and writes still work");

  const dir = join(repo, ".ynm");
  const configFile = join(dir, "config.json");
  let configWritten = false;
  const existing = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>)
    : {};
  if (existing.anchor !== anchor.sha) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configFile, `${JSON.stringify({ ...existing, anchor: anchor.sha }, null, 2)}\n`);
    configWritten = true;
  }

  const remote = opts.remote ?? "origin";
  const refspecs: string[] = [];
  const hasRemote = (await gitOrNull(["remote", "get-url", remote], { cwd: repo })) !== null;
  if (hasRemote) {
    const fetch = SHARED_FETCH(remote);
    const fetches =
      (await gitOrNull(["config", "--get-all", `remote.${remote}.fetch`], { cwd: repo })) ?? "";
    if (!fetches.split("\n").includes(fetch)) {
      await git(["config", "--add", `remote.${remote}.fetch`, fetch], { cwd: repo });
      refspecs.push(fetch);
    }
    const pushes =
      (await gitOrNull(["config", "--get-all", `remote.${remote}.push`], { cwd: repo })) ?? "";
    if (!pushes.split("\n").includes(SHARED_PUSH)) {
      // Keep normal branch pushes working: an explicit push refspec would otherwise replace the default.
      if (!pushes.split("\n").some((l) => l === "HEAD" || l.startsWith("refs/heads/"))) {
        await git(["config", "--add", `remote.${remote}.push`, "HEAD"], { cwd: repo });
        refspecs.push("HEAD");
      }
      await git(["config", "--add", `remote.${remote}.push`, SHARED_PUSH], { cwd: repo });
      refspecs.push(SHARED_PUSH);
    }
  } else {
    notes.push(
      `remote "${remote}" not found; refspecs not configured (re-run init after adding it)`
    );
  }

  const hooksInstalled: string[] = [];
  if (opts.hooks ?? true) {
    const hooksDir = (
      (await gitOrNull(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], {
        cwd: repo,
      })) ?? join(wt.gitCommonDir, "hooks")
    ).trim();
    mkdirSync(hooksDir, { recursive: true });
    const prePush = join(hooksDir, "pre-push");
    if (!existsSync(prePush)) {
      writeFileSync(prePush, PRE_PUSH_HOOK);
      chmodSync(prePush, 0o755);
      hooksInstalled.push(prePush);
    } else if (!readFileSync(prePush, "utf8").includes("ynm sync")) {
      notes.push(`pre-push hook exists and was left alone: ${prePush}`);
    }
  }
  return {
    repo,
    anchor: anchor.sha,
    anchorSource: anchor.source,
    configFile,
    configWritten,
    refspecs,
    hooksInstalled,
    notes,
  };
}

/** Creates or adopts a dedicated bare memory repo with one root commit (ADR-009). */
export async function initBare(
  path: string
): Promise<{ repo: string; anchor: string; created: boolean }> {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    await git(["init", "-q", "--bare", "-b", "main", path], { cwd: path });
  }
  const created = !(await findRootCommit(path));
  const anchor =
    (await findRootCommit(path)) ?? (await createRootCommit(path, await identityEnv(path)));
  return { repo: path, anchor, created };
}

export { ensurePersonalStore as initPersonal };
