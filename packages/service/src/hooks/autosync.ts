import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncConfig } from "../config.js";
import type { Ynm } from "../ynm.js";

export interface AutoSyncOptions {
  sync: SyncConfig;
  env: NodeJS.ProcessEnv;
  /** The ynm home; the stamp lives in its `hooks` folder. */
  home: string;
  /** The main repository path: one stamp per repository, shared by every session in it. */
  repo: string;
  now?: number;
  /** Starts `ynm sync --quiet` detached; injected so tests spawn nothing. */
  launch: () => void;
}

/** The per-repository stamp: its mtime is when an automatic sync was last launched. */
export function autoSyncStamp(home: string, repo: string): string {
  const id = createHash("sha256").update(repo).digest("hex").slice(0, 12);
  return join(home, "hooks", `autosync-${id}`);
}

/**
 * Whether this Stop should start a background sync: `sync.auto` is on, no sync is already
 * running this one (`YNM_SYNC_IN_PROGRESS`), the repository's last launch is older than
 * `intervalMinutes`, and a distributed mount has writes the remote has not seen. A write made
 * inside the interval is not skipped: it is still unpushed at the first Stop after the window.
 */
export async function shouldAutoSync(ynm: Ynm, o: AutoSyncOptions): Promise<boolean> {
  if (!o.sync.auto || o.env.YNM_SYNC_IN_PROGRESS) return false;
  try {
    const age = (o.now ?? Date.now()) - statSync(autoSyncStamp(o.home, o.repo)).mtimeMs;
    if (age < o.sync.intervalMinutes * 60_000) return false;
  } catch {
    // no stamp yet
  }
  return ynm.hasUnpushed();
}

/**
 * Stop hook tail: launches a background sync when `shouldAutoSync` says so, stamping first so a
 * concurrent Stop from another session does not launch a second one. Never throws; the turn
 * is never delayed by it. Returns whether a sync was launched.
 */
export async function autoSyncOnStop(ynm: Ynm, o: AutoSyncOptions): Promise<boolean> {
  try {
    if (!(await shouldAutoSync(ynm, o))) return false;
    const stamp = autoSyncStamp(o.home, o.repo);
    mkdirSync(join(o.home, "hooks"), { recursive: true });
    writeFileSync(stamp, "");
    o.launch();
    return true;
  } catch (err) {
    process.stderr.write(`ynm hook: auto-sync skipped: ${(err as Error).message}\n`);
    return false;
  }
}
