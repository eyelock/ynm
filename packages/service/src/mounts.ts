import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Level } from "@ynm/model";
import { FsLog, GitNotesLog, MemoryLog, type RecordLog, SqliteLog, selectAnchor } from "@ynm/store";
import type { LoadedConfig, MountConfig } from "./config.js";
import { ensurePersonalStore } from "./personal-store.js";
import type { WorktreeInfo } from "./worktree.js";

export interface Mount {
  id: string;
  level: Level;
  log: RecordLog;
  /** Where the log lives, for status and doctor. */
  location: string;
}

function openLog(
  id: string,
  level: Level,
  cfg: { provider: string; path: string; anchor?: string; remote?: string }
): RecordLog {
  switch (cfg.provider) {
    case "fs":
      return new FsLog(id, level, cfg.path);
    case "memory":
      return new MemoryLog(id, level);
    case "sqlite":
      return new SqliteLog(
        id,
        level,
        cfg.path.endsWith(".sqlite") ? cfg.path : join(cfg.path, "store.sqlite")
      );
    default:
      if (!cfg.anchor) throw new Error(`mount ${id}: git-notes provider needs an anchor`);
      return new GitNotesLog(id, level, { repo: cfg.path, anchor: cfg.anchor, remote: cfg.remote });
  }
}

export interface OpenMountsOptions {
  loaded: LoadedConfig;
  worktree: WorktreeInfo;
  /** Skip the personal mount (hosted servers). */
  noPersonal?: boolean;
}

/** True when `ynm init` has been run for this repository. */
export function projectInitialised(worktree: WorktreeInfo): boolean {
  return worktree.isGitRepo && existsSync(join(worktree.mainRepoPath, ".ynm", "config.json"));
}

/**
 * Mount table (ADR-004): personal store always (unless disabled), the project's shared refs when
 * the repo has been initialised, then any explicit mounts from config.
 */
export async function openMounts(opts: OpenMountsOptions): Promise<Mount[]> {
  const { config } = opts.loaded;
  const mounts: Mount[] = [];
  if (!opts.noPersonal) {
    if (config.provider === "git-notes") {
      const store = await ensurePersonalStore(config.personalStore as string);
      mounts.push({
        id: "personal",
        level: "personal",
        location: store.repo,
        log: openLog("personal", "personal", {
          provider: "git-notes",
          path: store.repo,
          anchor: store.anchor,
        }),
      });
    } else {
      const path = join(opts.loaded.home, `store-${config.provider}`);
      mounts.push({
        id: "personal",
        level: "personal",
        location: path,
        log: openLog("personal", "personal", { provider: config.provider, path }),
      });
    }
  }
  if (projectInitialised(opts.worktree)) {
    const repo = opts.worktree.mainRepoPath;
    if (config.provider === "git-notes") {
      const anchor = (await selectAnchor(repo, { configured: config.anchor })).sha;
      mounts.push({
        id: "project",
        level: "distributed",
        location: repo,
        log: openLog("project", "distributed", {
          provider: "git-notes",
          path: repo,
          anchor,
          remote: config.remote,
        }),
      });
    } else {
      const path = join(repo, ".ynm", `store-${config.provider}`);
      mounts.push({
        id: "project",
        level: "distributed",
        location: path,
        log: openLog("project", "distributed", { provider: config.provider, path }),
      });
    }
  }
  for (const m of config.mounts ?? []) mounts.push(openConfiguredMount(m));
  return mounts;
}

export function openConfiguredMount(m: MountConfig): Mount {
  return { id: m.id, level: m.level, location: m.path, log: openLog(m.id, m.level, m) };
}
