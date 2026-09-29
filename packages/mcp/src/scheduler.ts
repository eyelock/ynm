import { Lifecycle, type Ynm } from "@ynm/service";

export interface SchedulerOptions {
  /** Run consolidation (all passes) every N ms; 0 or undefined disables. */
  dreamEveryMs?: number;
  /** Run `sync` on every mount every N ms; 0 or undefined disables. */
  syncEveryMs?: number;
  quiet?: boolean;
  now?: () => Date;
}

export interface SchedulerStats {
  dreamRuns: number;
  syncRuns: number;
  lastDreamAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Memory ids changed by the last dream run, per pass. */
  lastDream: Record<string, { candidates: number; changed: number }> | null;
}

export interface SchedulerHandle {
  readonly stats: SchedulerStats;
  /** Runs one dream cycle now (used by tests and by an operator's signal). */
  dreamNow(): Promise<void>;
  syncNow(): Promise<void>;
  stop(): void;
}

/** `15m`, `90s`, `2h`, `500ms`; plain numbers are milliseconds. */
export function parseEvery(value: string | undefined): number {
  if (!value) return 0;
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`bad interval "${value}" (use e.g. 30s, 15m, 2h)`);
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"] as number);
}

/**
 * Hosted mode is the single writer for its store (ADR-009), so the dream worker lives in the
 * same process: a timer runs consolidation and, optionally, sync. Runs never overlap; a failing
 * run is recorded on the stats and the next tick tries again.
 */
export function startScheduler(
  getYnm: () => Promise<Ynm>,
  opts: SchedulerOptions
): SchedulerHandle {
  const stats: SchedulerStats = {
    dreamRuns: 0,
    syncRuns: 0,
    lastDreamAt: null,
    lastSyncAt: null,
    lastError: null,
    lastDream: null,
  };
  const now = opts.now ?? (() => new Date());
  let dreaming: Promise<void> | null = null;
  let syncing: Promise<void> | null = null;
  const log = (msg: string) => {
    if (!opts.quiet) console.error(`[ynm-mcp scheduler] ${msg}`);
  };

  const dreamNow = (): Promise<void> => {
    dreaming ??= (async () => {
      try {
        const ynm = await getYnm();
        const report = await new Lifecycle(ynm, now).consolidate({ dryRun: false });
        stats.dreamRuns += 1;
        stats.lastDreamAt = now().toISOString();
        stats.lastDream = Object.fromEntries(
          Object.entries(report.passes).map(([k, v]) => [
            k,
            { candidates: v.candidates, changed: v.changed.length },
          ])
        );
        log(`dream #${stats.dreamRuns}: ${JSON.stringify(stats.lastDream)}`);
      } catch (err) {
        stats.lastError = `dream: ${err instanceof Error ? err.message : String(err)}`;
        log(stats.lastError);
      } finally {
        dreaming = null;
      }
    })();
    return dreaming;
  };

  const syncNow = (): Promise<void> => {
    syncing ??= (async () => {
      try {
        const ynm = await getYnm();
        await ynm.sync();
        stats.syncRuns += 1;
        stats.lastSyncAt = now().toISOString();
      } catch (err) {
        stats.lastError = `sync: ${err instanceof Error ? err.message : String(err)}`;
        log(stats.lastError);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  };

  const timers: NodeJS.Timeout[] = [];
  if (opts.dreamEveryMs && opts.dreamEveryMs > 0) {
    timers.push(setInterval(() => void dreamNow(), opts.dreamEveryMs));
    log(`dream every ${opts.dreamEveryMs}ms`);
  }
  if (opts.syncEveryMs && opts.syncEveryMs > 0) {
    timers.push(setInterval(() => void syncNow(), opts.syncEveryMs));
    log(`sync every ${opts.syncEveryMs}ms`);
  }
  return {
    stats,
    dreamNow,
    syncNow,
    stop: () => {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}
