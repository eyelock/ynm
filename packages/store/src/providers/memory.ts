import type { Level, MemoryRecord } from "@ynm/model";
import {
  type AppendResult,
  assertLevel,
  groupByShard,
  type HealthReport,
  type ParseProblem,
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
      shard.records.push(...group.records);
      shard.revision += 1;
      this.store.set(sid, shard);
      touched.push({ key: group.key, revision: String(shard.revision) });
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
      .map((s) => ({ ...s.key, records: s.records.length }));
  }

  async health(): Promise<HealthReport> {
    return { ok: true, problems: [], details: { shards: this.store.size } };
  }

  /** Test helper: the id of a shard as the log sees it. */
  static shardId(key: ShardKey): string {
    return shardId(key);
  }
}
