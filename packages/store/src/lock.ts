import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_MS = 15;
const STALE_MS = 60_000;

interface LockHolder {
  pid: number;
  startedAt: number;
  host: string | null;
}

function readHolder(content: string): LockHolder {
  // pid, start time (ms), token, host. Locks from older versions stop after the start time and
  // carry no host: treat them as this host's.
  const [pid, started, , host] = content.split("\n");
  return { pid: Number(pid), startedAt: Number(started), host: host || null };
}

/**
 * A holder on this host is judged by whether its process is alive, never by age: a sync can
 * legitimately hold the lock for longer than STALE_MS. Age is only a fallback for a holder on
 * another host (a shared filesystem), whose pid this host cannot probe.
 */
function isStale(content: string): boolean {
  const { pid, startedAt, host } = readHolder(content);
  if (host !== null && host !== hostname()) {
    return Number.isFinite(startedAt) && Date.now() - startedAt > STALE_MS;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/** Removes the lock when it is stale and still the one judged; true when it is gone. */
function breakIfStale(lockPath: string): boolean {
  let seen: string;
  try {
    seen = readFileSync(lockPath, "utf8");
  } catch {
    return true; // released between our attempt and now
  }
  if (!isStale(seen)) return false;
  releaseIfOwn(lockPath, seen);
  return true;
}

/** Unlinks the lock only when it still holds `content`, so a replaced lock is never removed. */
function releaseIfOwn(lockPath: string, content: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === content) unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

/**
 * Cross-process lock via O_EXCL file creation with stale-holder detection (adapted from an earlier
 * project's fs storage). Used by the fs and git-notes providers around read-modify-write.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const start = Date.now();
  const content = `${process.pid}\n${Date.now()}\n${randomUUID()}\n${hostname()}\n`;
  for (;;) {
    try {
      writeFileSync(lockPath, content, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (breakIfStale(lockPath)) continue;
      if (Date.now() - start > timeoutMs)
        throw new Error(`lock timeout after ${timeoutMs}ms: ${lockPath}`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    releaseIfOwn(lockPath, content);
  }
}
