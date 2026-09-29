import type { Level, MemoryRecord } from "@ynm/model";
import {
  type AppendResult,
  assertLevel,
  groupByShard,
  type HealthReport,
  type ParseProblem,
  type PurgeResult,
  type RecordLog,
  type ShardFilter,
  type ShardInfo,
  type ShardKey,
  shardId,
  shardMatches,
} from "../log.js";

/** In-process log for tests and ephemeral use. */
export class MemoryLog implements RecordLog {
  readonly provider = "memory";
  private readonly store = new Map<
    string,
    { key: ShardKey; records: MemoryRecord[]; revision: number }
  >();

  constructor(
    readonly id: string,
    readonly level: Level
  ) {}

  async append(records: readonly MemoryRecord[]): Promise<AppendResult> {
    assertLevel(this, records);
    const touched: AppendResult["shards"] = [];
    for (const [sid, group] of groupByShard(records)) {
      const shard = this.store.get(sid) ?? { key: group.key, records: [], revision: 0 };
      const previous = shard.revision ? String(shard.revision) : null;
      shard.records.push(...group.records);
      shard.revision += 1;
      this.store.set(sid, shard);
      touched.push({ key: group.key, revision: String(shard.revision), previous });
    }
    return { appended: records.length, shards: touched };
  }

  async *scan(
    filter?: ShardFilter,
    _onProblem?: (p: ParseProblem) => void
  ): AsyncIterable<MemoryRecord> {
    for (const shard of this.store.values()) {
      if (!shardMatches(shard.key, filter)) continue;
      for (const r of shard.records) yield r;
    }
  }

  async shards(filter?: ShardFilter): Promise<ShardInfo[]> {
    return [...this.store.values()]
      .filter((s) => shardMatches(s.key, filter))
      .map((s) => ({ ...s.key, records: s.records.length, revision: String(s.revision) }));
  }

  async health(): Promise<HealthReport> {
    return { ok: true, problems: [], details: { shards: this.store.size } };
  }

  async purge(memoryId: string): Promise<PurgeResult> {
    let removed = 0;
    const shards: ShardKey[] = [];
    for (const shard of this.store.values()) {
      const before = shard.records.length;
      shard.records = shard.records.filter((r) => r.memoryId !== memoryId);
      if (shard.records.length !== before) {
        removed += before - shard.records.length;
        shard.revision += 1;
        shards.push(shard.key);
      }
    }
    return { removed, shards };
  }

  /** Test helper: the id of a shard as the log sees it. */
  static shardId(key: ShardKey): string {
    return shardId(key);
  }
}
