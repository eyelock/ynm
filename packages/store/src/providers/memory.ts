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
  type StoreDocument,
  shardId,
  shardMatches,
} from "../log.js";

const DOCUMENT_NAME = /^[a-z0-9-]+$/;

function assertDocumentName(name: string): void {
  if (!DOCUMENT_NAME.test(name)) throw new Error(`invalid document name: ${JSON.stringify(name)}`);
}

/** In-process log for tests and ephemeral use. */
export class MemoryLog implements RecordLog {
  readonly provider = "memory";
  private readonly store = new Map<
    string,
    { key: ShardKey; records: MemoryRecord[]; revision: number }
  >();
  private readonly documents = new Map<string, StoreDocument>();
  private documentVersion = 0;

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

  async readDocument(name: string): Promise<StoreDocument | null> {
    assertDocumentName(name);
    const doc = this.documents.get(name);
    return doc ? { ...doc } : null;
  }

  async writeDocument(name: string, text: string, expected: string | null): Promise<string | null> {
    assertDocumentName(name);
    if ((this.documents.get(name)?.version ?? null) !== expected) return null;
    this.documentVersion += 1;
    const version = String(this.documentVersion);
    this.documents.set(name, { text, version });
    return version;
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
