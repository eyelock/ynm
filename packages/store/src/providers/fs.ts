import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Level, MemoryRecord } from "@ynm/model";
import { LEVELS, MEMORY_TYPES } from "@ynm/model";
import { withLock } from "../lock.js";
import {
  type AppendResult,
  assertLevel,
  BUCKET_PATTERN,
  groupByShard,
  type HealthReport,
  type ParseProblem,
  type RecordLog,
  type ShardFilter,
  type ShardInfo,
  type ShardKey,
  shardMatches,
} from "../log.js";
import { parseJsonl, serializeJsonl } from "../parse.js";

/**
 * JSONL files on disk: <dir>/<level>/<namespace...>/<type>/<yyyy-mm>.jsonl, atomic
 * temp-file-then-rename writes, one lock per shard. Offline use, non-git hosting, tests.
 */
export class FsLog implements RecordLog {
  readonly provider = "fs";

  constructor(
    readonly id: string,
    readonly level: Level,
    readonly dir: string
  ) {}

  private shardPath(key: ShardKey): string {
    return join(this.dir, key.level, ...key.namespace.split("/"), key.type, `${key.bucket}.jsonl`);
  }

  async append(records: readonly MemoryRecord[]): Promise<AppendResult> {
    assertLevel(this, records);
    const touched: AppendResult["shards"] = [];
    for (const group of groupByShard(records).values()) {
      const file = this.shardPath(group.key);
      mkdirSync(join(file, ".."), { recursive: true });
      await withLock(`${file}.lock`, async () => {
        const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, existing + serializeJsonl(group.records));
        renameSync(tmp, file);
      });
      touched.push({ key: group.key, revision: String(statSync(file).mtimeMs) });
    }
    return { appended: records.length, shards: touched };
  }

  private *walk(): Iterable<{ key: ShardKey; file: string }> {
    for (const level of LEVELS) {
      const levelDir = join(this.dir, level);
      if (!existsSync(levelDir)) continue;
      const stack: Array<{ dir: string; segments: string[] }> = [{ dir: levelDir, segments: [] }];
      while (stack.length) {
        const { dir, segments } = stack.pop() as { dir: string; segments: string[] };
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const name = entry.name;
          if ((MEMORY_TYPES as readonly string[]).includes(name) && segments.length > 0) {
            const typeDir = join(dir, name);
            for (const f of readdirSync(typeDir)) {
              const bucket = f.replace(/\.jsonl$/, "");
              if (!f.endsWith(".jsonl") || !BUCKET_PATTERN.test(bucket)) continue;
              yield {
                key: {
                  level,
                  namespace: segments.join("/"),
                  type: name as ShardKey["type"],
                  bucket,
                },
                file: join(typeDir, f),
              };
            }
          } else {
            stack.push({ dir: join(dir, name), segments: [...segments, name] });
          }
        }
      }
    }
  }

  async *scan(
    filter?: ShardFilter,
    onProblem?: (p: ParseProblem) => void
  ): AsyncIterable<MemoryRecord> {
    for (const { key, file } of this.walk()) {
      if (!shardMatches(key, filter)) continue;
      const { records, problems } = parseJsonl(readFileSync(file, "utf8"));
      for (const p of problems) onProblem?.({ shard: key, ...p });
      for (const r of records) yield r;
    }
  }

  async shards(filter?: ShardFilter): Promise<ShardInfo[]> {
    const out: ShardInfo[] = [];
    for (const { key } of this.walk()) if (shardMatches(key, filter)) out.push({ ...key });
    return out;
  }

  async health(): Promise<HealthReport> {
    const problems: string[] = [];
    let shards = 0;
    for (const { key, file } of this.walk()) {
      shards += 1;
      const { problems: p } = parseJsonl(readFileSync(file, "utf8"));
      for (const x of p)
        problems.push(
          `${key.level}/${key.namespace}/${key.type}/${key.bucket}:${x.line} ${x.message}`
        );
    }
    return { ok: problems.length === 0, problems, details: { dir: this.dir, shards } };
  }
}
