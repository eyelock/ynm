import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { parseJsonl } from "../parse.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, memoryId TEXT NOT NULL, shard TEXT NOT NULL,
  level TEXT NOT NULL, namespace TEXT NOT NULL, type TEXT NOT NULL, bucket TEXT NOT NULL,
  recordedAt TEXT NOT NULL, line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_shard ON records(shard);
CREATE INDEX IF NOT EXISTS records_memory ON records(memoryId);
CREATE TABLE IF NOT EXISTS shards (shard TEXT PRIMARY KEY, level TEXT NOT NULL, namespace TEXT NOT NULL, type TEXT NOT NULL, bucket TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
`;

/**
 * SQLite record log (ADR-004): the scale escape hatch for hosted stores and a git-free option.
 * One row per record line; shards are rows in a side table with a revision counter. WAL mode
 * plus a busy timeout keeps concurrent writers safe. No replication.
 */
export class SqliteLog implements RecordLog {
  readonly provider = "sqlite";
  private readonly db: DatabaseSync;

  constructor(
    readonly id: string,
    readonly level: Level,
    readonly file: string
  ) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;"
    );
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async append(records: readonly MemoryRecord[]): Promise<AppendResult> {
    assertLevel(this, records);
    const touched: AppendResult["shards"] = [];
    if (records.length === 0) return { appended: 0, shards: touched };
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO records (id, memoryId, shard, level, namespace, type, bucket, recordedAt, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const bump = this.db.prepare(
      "INSERT INTO shards (shard, level, namespace, type, bucket, revision) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(shard) DO UPDATE SET revision = revision + 1 RETURNING revision"
    );
    const prev = this.db.prepare("SELECT revision FROM shards WHERE shard = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const g of groupByShard(records).values()) {
        const sid = shardId(g.key);
        const before = prev.get(sid) as { revision: number } | undefined;
        for (const r of g.records)
          ins.run(
            r.id,
            r.memoryId,
            sid,
            r.level,
            r.namespace,
            r.type,
            g.key.bucket,
            r.recordedAt,
            JSON.stringify(r)
          );
        const row = bump.get(sid, g.key.level, g.key.namespace, g.key.type, g.key.bucket) as {
          revision: number;
        };
        touched.push({
          key: g.key,
          revision: String(row.revision),
          previous: before ? String(before.revision) : null,
        });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { appended: records.length, shards: touched };
  }

  private shardRows(filter?: ShardFilter): Array<ShardKey & { shard: string; revision: number }> {
    const rows = this.db
      .prepare("SELECT shard, level, namespace, type, bucket, revision FROM shards")
      .all() as Array<{
      shard: string;
      level: Level;
      namespace: string;
      type: ShardKey["type"];
      bucket: string;
      revision: number;
    }>;
    return rows.filter((r) => r.level === this.level && shardMatches(r, filter));
  }

  async *scan(
    filter?: ShardFilter,
    onProblem?: (p: ParseProblem) => void
  ): AsyncIterable<MemoryRecord> {
    const stmt = this.db.prepare(
      "SELECT line FROM records WHERE shard = ? ORDER BY recordedAt, id"
    );
    for (const s of this.shardRows(filter)) {
      const lines = (stmt.all(s.shard) as Array<{ line: string }>).map((r) => r.line).join("\n");
      const { records, problems } = parseJsonl(`${lines}\n`);
      for (const p of problems)
        onProblem?.({
          shard: { level: s.level, namespace: s.namespace, type: s.type, bucket: s.bucket },
          ...p,
        });
      for (const r of records) yield r;
    }
  }

  async shards(filter?: ShardFilter): Promise<ShardInfo[]> {
    return this.shardRows(filter).map((s) => ({
      level: s.level,
      namespace: s.namespace,
      type: s.type,
      bucket: s.bucket,
      revision: String(s.revision),
    }));
  }

  async health(): Promise<HealthReport> {
    const problems: string[] = [];
    let bad = 0;
    for await (const _ of this.scan(undefined, (p) => {
      bad += 1;
      problems.push(`${shardId(p.shard)}:${p.line} ${p.message}`);
    })) {
      // drain
    }
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n;
    return {
      ok: bad === 0,
      problems,
      details: { file: this.file, records: n, shards: this.shardRows().length },
    };
  }

  async purge(memoryId: string): Promise<PurgeResult> {
    const rows = this.db
      .prepare("SELECT DISTINCT shard FROM records WHERE memoryId = ?")
      .all(memoryId) as Array<{ shard: string }>;
    const res = this.db.prepare("DELETE FROM records WHERE memoryId = ?").run(memoryId);
    const bump = this.db.prepare("UPDATE shards SET revision = revision + 1 WHERE shard = ?");
    const keys: ShardKey[] = [];
    for (const { shard } of rows) {
      bump.run(shard);
      const s = this.shardRows().find((x) => x.shard === shard);
      if (s) keys.push({ level: s.level, namespace: s.namespace, type: s.type, bucket: s.bucket });
    }
    return { removed: Number(res.changes), shards: keys };
  }
}
