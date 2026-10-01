import type { Level, MemoryRecord, MemoryType } from "@ynm/model";

/** A shard is one (level, namespace, type, month) partition of the log (ADR-003). */
export interface ShardKey {
  level: Level;
  namespace: string;
  type: MemoryType;
  /** yyyy-mm, from the record's recordedAt. */
  bucket: string;
}

export interface ShardInfo extends ShardKey {
  /** Number of records, when the provider knows cheaply; otherwise undefined. */
  records?: number;
  /** Provider revision of the shard (git commit sha, file mtime, counter). Changes on every append. */
  revision: string;
}

export interface ShardFilter {
  level?: Level;
  /** Namespace prefix match on whole segments. */
  namespace?: string;
  type?: MemoryType;
  /** Inclusive bucket bounds, yyyy-mm. */
  fromBucket?: string;
  toBucket?: string;
}

export interface AppendResult {
  appended: number;
  /**
   * Shards touched, with the provider revision after the append and the one before it. An index
   * that last saw a different `previous` knows another writer got in between (ADR-005).
   */
  shards: Array<{ key: ShardKey; revision: string; previous: string | null }>;
}

export interface ParseProblem {
  shard: ShardKey;
  line: number;
  message: string;
}

export interface HealthReport {
  ok: boolean;
  problems: string[];
  details: Record<string, unknown>;
}

export interface SyncOptions {
  remote?: string;
  push?: boolean;
  pull?: boolean;
  dryRun?: boolean;
}

export interface SyncResult {
  fetched: number;
  merged: string[];
  pushed: string[];
  conflicts: string[];
  retries: number;
  /** Set when the sync could not run at all (no such remote); a report, not a failure. */
  skipped?: string;
}

/**
 * The record log seam (ADR-004). Providers move lines; the fold and everything above talk to
 * this interface only. A log is entirely personal or entirely distributed.
 */
export interface RecordLog {
  readonly id: string;
  readonly level: Level;
  readonly provider: string;
  /** Appends records atomically. Every record's level must equal this log's level. */
  append(records: readonly MemoryRecord[]): Promise<AppendResult>;
  /** Streams records from matching shards. Bad lines are reported through onProblem, never thrown. */
  scan(filter?: ShardFilter, onProblem?: (p: ParseProblem) => void): AsyncIterable<MemoryRecord>;
  shards(filter?: ShardFilter): Promise<ShardInfo[]>;
  health(): Promise<HealthReport>;
  /** Present only on replicating providers. */
  sync?(options?: SyncOptions): Promise<SyncResult>;
  /**
   * Physically removes every line of a memory (ADR-002 purge). Rewrites the affected shards;
   * with `forgetHistory` the shard's revision history is dropped too where the provider has one.
   */
  purge(memoryId: string, options?: { forgetHistory?: boolean }): Promise<PurgeResult>;
}

export interface PurgeResult {
  removed: number;
  shards: ShardKey[];
}

export const BUCKET_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function bucketOf(recordedAt: string): string {
  return recordedAt.slice(0, 7);
}

export function shardKeyOf(record: MemoryRecord): ShardKey {
  return {
    level: record.level,
    namespace: record.namespace,
    type: record.type,
    bucket: bucketOf(record.recordedAt),
  };
}

export function shardId(key: ShardKey): string {
  return `${key.level}/${key.namespace}/${key.type}/${key.bucket}`;
}

/** Whole-segment prefix match: "org/eyelock" matches "org/eyelock/x" but not "org/eyelockx". */
export function namespaceMatches(namespace: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  return namespace === prefix || namespace.startsWith(`${prefix}/`);
}

export function shardMatches(key: ShardKey, filter: ShardFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.level && key.level !== filter.level) return false;
  if (filter.type && key.type !== filter.type) return false;
  if (!namespaceMatches(key.namespace, filter.namespace)) return false;
  if (filter.fromBucket && key.bucket < filter.fromBucket) return false;
  if (filter.toBucket && key.bucket > filter.toBucket) return false;
  return true;
}

export class LevelMismatchError extends Error {
  constructor(logId: string, logLevel: Level, recordLevel: Level) {
    super(`log "${logId}" is ${logLevel}; refusing a ${recordLevel} record`);
    this.name = "LevelMismatchError";
  }
}

export function assertLevel(
  log: Pick<RecordLog, "id" | "level">,
  records: readonly MemoryRecord[]
): void {
  for (const r of records) {
    if (r.level !== log.level) throw new LevelMismatchError(log.id, log.level, r.level);
  }
}

/** Groups records by shard, preserving order within each shard. */
export function groupByShard(
  records: readonly MemoryRecord[]
): Map<string, { key: ShardKey; records: MemoryRecord[] }> {
  const groups = new Map<string, { key: ShardKey; records: MemoryRecord[] }>();
  for (const r of records) {
    const key = shardKeyOf(r);
    const id = shardId(key);
    const g = groups.get(id);
    if (g) g.records.push(r);
    else groups.set(id, { key, records: [r] });
  }
  return groups;
}
