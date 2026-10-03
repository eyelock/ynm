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

interface LogConfig {
  provider: string;
  path?: string;
  anchor?: string;
  remote?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
}

type StoreS3 = typeof import("@ynm/store-s3");

/**
 * The s3 provider lives in its own package so the AWS SDK stays out of the CLI bundles; it is
 * loaded only when a mount asks for it. `load` is injectable for tests.
 */
export async function loadStoreS3(
  id: string,
  load: () => Promise<StoreS3> = () => import("@ynm/store-s3")
): Promise<StoreS3> {
  try {
    return await load();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      throw new Error(
        `mount ${id}: this build of ynm does not include the s3 provider; run ynm from the Docker image or a source checkout to mount an s3 store`
      );
    throw err;
  }
}

async function openLog(id: string, level: Level, cfg: LogConfig): Promise<RecordLog> {
  if (cfg.provider === "s3") {
    if (!cfg.bucket) throw new Error(`mount ${id}: the s3 provider needs a bucket`);
    const { openS3Log } = await loadStoreS3(id);
    return openS3Log(id, level, { bucket: cfg.bucket, prefix: cfg.prefix, region: cfg.region });
  }
  if (!cfg.path) throw new Error(`mount ${id}: the ${cfg.provider} provider needs a path`);
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
 * Mount table (ADR-004): personal store always (unless disabled), the project's distributed refs when
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
        log: await openLog("personal", "personal", {
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
        log: await openLog("personal", "personal", { provider: config.provider, path }),
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
        log: await openLog("project", "distributed", {
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
        log: await openLog("project", "distributed", { provider: config.provider, path }),
      });
    }
  }
  // An mcp mount holds no records here; openYnm opens it as a remote store.
  for (const m of config.mounts ?? [])
    if (m.provider !== "mcp") mounts.push(await openConfiguredMount(m));
  return mounts;
}

/** An explicit mount from config; a git-notes mount without an `anchor` computes it, as the project mount does. */
export async function openConfiguredMount(m: MountConfig): Promise<Mount> {
  const anchor =
    m.provider === "git-notes" && !m.anchor && m.path ? (await selectAnchor(m.path)).sha : m.anchor;
  const log = await openLog(m.id, m.level, { ...m, anchor });
  const location = m.provider === "s3" ? `s3://${m.bucket}/${m.prefix ?? ""}` : (m.path as string);
  return { id: m.id, level: m.level, location, log };
}
