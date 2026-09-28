import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_MS = 15;
const STALE_MS = 60_000;

function isStale(lockPath: string): boolean {
  try {
    const [pid, started] = readFileSync(lockPath, "utf8").split("\n");
    const startedAt = Number(started);
    if (Number.isFinite(startedAt) && Date.now() - startedAt > STALE_MS) return true;
    if (pid) {
      try {
        process.kill(Number(pid), 0);
        return false;
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Cross-process lock via O_EXCL file creation with stale-holder detection (copied in spirit
 * from ACME's fs storage). Used by the fs and git-notes providers around read-modify-write.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isStale(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // another process removed it first
        }
      }
      if (Date.now() - start > timeoutMs)
        throw new Error(`lock timeout after ${timeoutMs}ms: ${lockPath}`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}
