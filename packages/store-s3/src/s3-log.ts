import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  type GetBucketVersioningCommandOutput,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { Level, MemoryRecord } from "@ynm/model";
import { LEVELS, MEMORY_TYPES, ulid } from "@ynm/model";
import {
  type AppendResult,
  assertLevel,
  BUCKET_PATTERN,
  groupByShard,
  type HealthReport,
  type ParseProblem,
  type PurgeResult,
  parseJsonl,
  type RecordLog,
  type ShardFilter,
  type ShardInfo,
  type ShardKey,
  serializeJsonl,
  shardId,
  shardMatches,
} from "@ynm/store";

/** The S3 commands this provider sends. */
export type S3Command =
  | PutObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | DeleteObjectCommand
  | ListObjectsV2Command
  | ListObjectVersionsCommand
  | GetBucketVersioningCommand;

/**
 * The part of an S3 client the provider uses. The SDK's `S3Client` satisfies it; tests pass the
 * in-memory double from `@ynm/store-s3/testing`.
 */
export interface S3Like {
  send(command: S3Command): Promise<unknown>;
}

export interface S3LogOptions {
  client: S3Like;
  bucket: string;
  /** Key prefix every object of this log sits under; leading and trailing slashes are ignored. */
  prefix?: string;
}

export interface CompactOptions {
  /** Compact only when the shard holds more objects than this. Default 32. */
  threshold?: number;
}

export interface CompactResult {
  shard: ShardKey;
  compacted: boolean;
  /** Objects the shard held when compaction looked. */
  inputs: number;
  /** The object that now holds the shard's lines, when compacted. */
  output?: string;
  /** Set when a concurrent purge or compaction changed an input, so this run backed off. */
  aborted?: string;
}

export const DEFAULT_COMPACT_THRESHOLD = 32;
const RETRIES = 10;
const READ_CONCURRENCY = 8;
const OBJECT_NAME = /^[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;

interface ObjectRef {
  key: string;
  name: string;
  etag: string;
}

interface ShardObjects {
  key: ShardKey;
  objects: ObjectRef[];
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function errName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

/** A conditional write lost: the object changed (412) or another conditional write raced (409). */
export function isPreconditionFailed(err: unknown): boolean {
  const s = httpStatus(err);
  const n = errName(err);
  return s === 412 || s === 409 || n === "PreconditionFailed" || n === "ConditionalRequestConflict";
}

export function isNotFound(err: unknown): boolean {
  const n = errName(err);
  return httpStatus(err) === 404 || n === "NoSuchKey" || n === "NotFound";
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Revision of a shard: its greatest object name plus a digest of every (name, ETag) in it, so an
 * append, a purge's in-place rewrite and a compaction all change it, and an object that lands
 * out of key order (another writer's clock) is still noticed.
 */
function revisionOf(objects: readonly ObjectRef[]): string | null {
  if (objects.length === 0) return null;
  const h = createHash("sha256");
  for (const o of objects) h.update(`${o.name} ${o.etag}\n`);
  const last = (objects[objects.length - 1] as ObjectRef).name.replace(/\.jsonl$/, "");
  return `${last}-${h.digest("hex").slice(0, 12)}`;
}

let lastKeyTime = 0;

/** Object names strictly increase within a process, so one writer's objects read back in order. */
function nextObjectName(): string {
  lastKeyTime = Math.max(Date.now(), lastKeyTime + 1);
  return `${ulid(lastKeyTime)}.jsonl`;
}

function byName(a: ObjectRef, b: ObjectRef): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Record log in an S3 bucket (ADR-004): `<prefix>/<level>/<namespace...>/<type>/<yyyy-mm>/<ulid>.jsonl`.
 * Every append writes new objects under fresh ULID keys with `If-None-Match: *`, so writers never
 * collide and need no lock: any number of servers, functions and CLIs can append at once. Scan
 * de-duplicates by record id, because a compaction in flight can show a record in two objects.
 * No replication.
 */
export class S3Log implements RecordLog {
  readonly provider = "s3";
  readonly bucket: string;
  readonly prefix: string;
  private readonly client: S3Like;
  private readonly root: string;

  constructor(
    readonly id: string,
    readonly level: Level,
    options: S3LogOptions
  ) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.root = this.prefix ? `${this.prefix}/` : "";
  }

  /** `s3://bucket/prefix`, for status and doctor. */
  get location(): string {
    return `s3://${this.bucket}/${this.prefix}`;
  }

  private shardPrefix(key: ShardKey): string {
    return `${this.root}${key.level}/${key.namespace}/${key.type}/${key.bucket}/`;
  }

  /** Reads `<level>/<namespace...>/<type>/<bucket>/<ulid>.jsonl` from the end; null for strays. */
  private parseKey(objectKey: string): { shard: ShardKey; name: string } | null {
    if (!objectKey.startsWith(this.root)) return null;
    const parts = objectKey.slice(this.root.length).split("/");
    if (parts.length < 5) return null;
    const name = parts[parts.length - 1] as string;
    const bucket = parts[parts.length - 2] as string;
    const type = parts[parts.length - 3] as string;
    const level = parts[0] as string;
    const namespace = parts.slice(1, -3);
    if (!OBJECT_NAME.test(name) || !BUCKET_PATTERN.test(bucket)) return null;
    if (!(MEMORY_TYPES as readonly string[]).includes(type)) return null;
    if (!(LEVELS as readonly string[]).includes(level)) return null;
    if (namespace.some((s) => s === "")) return null;
    return {
      shard: {
        level: level as Level,
        namespace: namespace.join("/"),
        type: type as ShardKey["type"],
        bucket,
      },
      name,
    };
  }

  /** Narrowest listing prefix for a filter; null when the filter excludes this log's level. */
  private listPrefix(filter?: ShardFilter): string | null {
    if (filter?.level && filter.level !== this.level) return null;
    const base = `${this.root}${this.level}/`;
    return filter?.namespace ? `${base}${filter.namespace}/` : base;
  }

  /** One paginated ListObjectsV2 under `prefix`, grouped by shard, objects in key order. */
  private async list(prefix: string): Promise<Map<string, ShardObjects>> {
    const shards = new Map<string, ShardObjects>();
    let token: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )) as ListObjectsV2CommandOutput;
      for (const o of page.Contents ?? []) {
        if (!o.Key) continue;
        const parsed = this.parseKey(o.Key);
        if (!parsed || parsed.shard.level !== this.level) continue;
        const id = shardId(parsed.shard);
        const ref: ObjectRef = { key: o.Key, name: parsed.name, etag: o.ETag ?? "" };
        const s = shards.get(id);
        if (s) s.objects.push(ref);
        else shards.set(id, { key: parsed.shard, objects: [ref] });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    for (const s of shards.values()) s.objects.sort(byName);
    return shards;
  }

  private async listShard(key: ShardKey): Promise<ObjectRef[]> {
    return (await this.list(this.shardPrefix(key))).get(shardId(key))?.objects ?? [];
  }

  /** The object's text and ETag, or null when it is gone (compacted or emptied by a purge). */
  private async read(key: string): Promise<{ text: string; etag: string } | null> {
    try {
      const res = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      )) as GetObjectCommandOutput;
      return { text: (await res.Body?.transformToString("utf8")) ?? "", etag: res.ETag ?? "" };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async head(key: string): Promise<string | null> {
    try {
      const res = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      )) as HeadObjectCommandOutput;
      return res.ETag ?? "";
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private async remove(key: string, versionId?: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId })
    );
  }

  /** Writes `body` as a new object in the shard under a fresh ULID key, never overwriting. */
  private async putNew(shard: ShardKey, body: string): Promise<ObjectRef> {
    for (let attempt = 0; ; attempt++) {
      const name = nextObjectName();
      const key = `${this.shardPrefix(shard)}${name}`;
      try {
        const res = (await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: "application/x-ndjson",
            IfNoneMatch: "*",
          })
        )) as PutObjectCommandOutput;
        return { key, name, etag: res.ETag ?? "" };
      } catch (err) {
        if (!isPreconditionFailed(err) || attempt >= RETRIES) throw err;
      }
    }
  }

  async append(records: readonly MemoryRecord[]): Promise<AppendResult> {
    assertLevel(this, records);
    const touched: AppendResult["shards"] = [];
    for (const group of groupByShard(records).values()) {
      const before = await this.listShard(group.key);
      const written = await this.putNew(group.key, serializeJsonl(group.records));
      // The revision is "what was there plus this write": anything another writer added in
      // between makes the next listing differ, so an index that trusts it still notices.
      touched.push({
        key: group.key,
        previous: revisionOf(before),
        revision: revisionOf([...before, written].sort(byName)) as string,
      });
    }
    return { appended: records.length, shards: touched };
  }

  /**
   * Reads a shard's objects in key order, dropping record ids already yielded. An object that
   * vanished between listing and reading was compacted into a newer one, so the shard is listed
   * again and the objects not yet read are read.
   */
  private async *readShard(
    shard: ShardObjects,
    onBad: (name: string, line: number, message: string) => void
  ): AsyncIterable<MemoryRecord> {
    const seen = new Set<string>();
    const done = new Set<string>();
    let objects = shard.objects;
    for (let attempt = 0; ; attempt++) {
      const pending = objects.filter((o) => !done.has(o.key));
      const bodies = await mapLimit(pending, READ_CONCURRENCY, (o) => this.read(o.key));
      let vanished = false;
      for (let i = 0; i < pending.length; i++) {
        const o = pending[i] as ObjectRef;
        const body = bodies[i];
        done.add(o.key);
        if (!body) {
          vanished = true;
          continue;
        }
        const { records, problems } = parseJsonl(body.text);
        for (const p of problems) onBad(o.name, p.line, p.message);
        for (const r of records) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          yield r;
        }
      }
      if (!vanished || attempt >= RETRIES) return;
      objects = await this.listShard(shard.key);
    }
  }

  async *scan(
    filter?: ShardFilter,
    onProblem?: (p: ParseProblem) => void
  ): AsyncIterable<MemoryRecord> {
    const prefix = this.listPrefix(filter);
    if (prefix === null) return;
    for (const s of (await this.list(prefix)).values()) {
      if (!shardMatches(s.key, filter)) continue;
      yield* this.readShard(s, (name, line, message) =>
        onProblem?.({ shard: s.key, line, message: `${message} (object ${name})` })
      );
    }
  }

  async shards(filter?: ShardFilter): Promise<ShardInfo[]> {
    const prefix = this.listPrefix(filter);
    if (prefix === null) return [];
    const out: ShardInfo[] = [];
    for (const s of (await this.list(prefix)).values()) {
      if (shardMatches(s.key, filter))
        out.push({ ...s.key, revision: revisionOf(s.objects) as string });
    }
    return out;
  }

  /** The bucket's versioning status: Enabled, Suspended, Disabled, or unknown without permission. */
  async versioning(): Promise<string> {
    try {
      const res = (await this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket })
      )) as GetBucketVersioningCommandOutput;
      return res.Status ?? "Disabled";
    } catch {
      return "unknown";
    }
  }

  async health(): Promise<HealthReport> {
    const details: Record<string, unknown> = { bucket: this.bucket, prefix: this.prefix };
    const problems: string[] = [];
    try {
      const shards = await this.list(this.listPrefix() as string);
      let objects = 0;
      let records = 0;
      for (const s of shards.values()) {
        objects += s.objects.length;
        for await (const _ of this.readShard(s, (name, line, message) =>
          problems.push(`${shardId(s.key)}/${name}:${line} ${message}`)
        ))
          records += 1;
      }
      Object.assign(details, {
        shards: shards.size,
        objects,
        records,
        versioning: await this.versioning(),
      });
    } catch (err) {
      problems.push(`${this.location}: ${(err as Error).message}`);
    }
    return { ok: problems.length === 0, problems, details };
  }

  /**
   * Removes the memory's lines from one object: rewritten with `If-Match` on the ETag it was read
   * at (retried when another purge got there first), or deleted when nothing else is left.
   */
  private async purgeObject(
    key: string,
    memoryId: string
  ): Promise<{ dropped: string[]; gone: boolean }> {
    for (let attempt = 0; ; attempt++) {
      const body = await this.read(key);
      if (!body) return { dropped: [], gone: true };
      const kept: string[] = [];
      const dropped: string[] = [];
      for (const line of body.text.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: { id?: unknown; memoryId?: unknown } | null = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A bad line is kept for health to report; it cannot belong to the memory.
        }
        if (parsed?.memoryId === memoryId) dropped.push(String(parsed.id));
        else kept.push(line);
      }
      if (dropped.length === 0) return { dropped, gone: false };
      try {
        if (kept.length === 0) await this.remove(key);
        else
          await this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: key,
              Body: `${kept.join("\n")}\n`,
              ContentType: "application/x-ndjson",
              IfMatch: body.etag,
            })
          );
        return { dropped, gone: false };
      } catch (err) {
        if (!(isPreconditionFailed(err) || isNotFound(err)) || attempt >= RETRIES) throw err;
      }
    }
  }

  /** Deletes every noncurrent version and delete marker of `key` (a versioned bucket's history). */
  private async forgetVersions(key: string): Promise<void> {
    const versions: string[] = [];
    const markers: string[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        })
      )) as ListObjectVersionsCommandOutput;
      for (const v of page.Versions ?? [])
        if (v.Key === key && !v.IsLatest && v.VersionId) versions.push(v.VersionId);
      for (const m of page.DeleteMarkers ?? [])
        if (m.Key === key && m.VersionId) markers.push(m.VersionId);
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
    // Old versions first, so removing a delete marker never brings one back.
    for (const v of versions) await this.remove(key, v);
    for (const m of markers) await this.remove(key, m);
  }

  async purge(memoryId: string, options: { forgetHistory?: boolean } = {}): Promise<PurgeResult> {
    const removed = new Set<string>();
    const touched = new Map<string, ShardKey>();
    const recheck = new Map<string, ShardKey>();
    const rewritten = new Set<string>();
    let shards = [...(await this.list(this.listPrefix() as string)).values()];
    // Later passes recheck only the shards it touched or saw an object vanish from: a compaction
    // that read an object before this purge rewrote it may have put the lines in a newer object.
    for (let pass = 0; pass <= RETRIES; pass++) {
      let changed = false;
      for (const s of shards) {
        for (const o of s.objects) {
          const { dropped, gone } = await this.purgeObject(o.key, memoryId);
          if (gone) recheck.set(shardId(s.key), s.key);
          if (gone) changed = true;
          if (dropped.length === 0) continue;
          changed = true;
          for (const id of dropped) removed.add(id);
          touched.set(shardId(s.key), s.key);
          recheck.set(shardId(s.key), s.key);
          rewritten.add(o.key);
        }
      }
      if (!changed) break;
      shards = await Promise.all(
        [...recheck.values()].map(async (key) => ({ key, objects: await this.listShard(key) }))
      );
    }
    if (options.forgetHistory) for (const key of rewritten) await this.forgetVersions(key);
    return { removed: removed.size, shards: [...touched.values()] };
  }

  /**
   * Folds a shard's objects into one when it holds more than `threshold` (default 32): writes
   * every distinct line under a new key, then deletes the inputs. If a purge or another
   * compaction changed an input meanwhile, the new object is deleted and the inputs stay.
   * Readers in between see duplicates, which scan drops by record id.
   */
  async compact(shard: ShardKey, options: CompactOptions = {}): Promise<CompactResult> {
    const threshold = options.threshold ?? DEFAULT_COMPACT_THRESHOLD;
    const objects = await this.listShard(shard);
    const result: CompactResult = { shard, compacted: false, inputs: objects.length };
    if (objects.length <= threshold) return result;
    const bodies = await mapLimit(objects, READ_CONCURRENCY, (o) => this.read(o.key));
    if (bodies.some((b) => !b)) return { ...result, aborted: "an input vanished while reading" };
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const b of bodies) {
      for (const line of (b as { text: string }).text.split("\n")) {
        if (line.trim() === "") continue;
        let id: string = line;
        try {
          const parsed = JSON.parse(line) as { id?: unknown };
          if (typeof parsed?.id === "string") id = parsed.id;
        } catch {
          // A bad line is carried over verbatim, once.
        }
        if (seen.has(id)) continue;
        seen.add(id);
        lines.push(line);
      }
    }
    const output = await this.putNew(shard, `${lines.join("\n")}\n`);
    const now = await mapLimit(objects, READ_CONCURRENCY, (o) => this.head(o.key));
    if (now.some((etag, i) => etag !== (bodies[i] as { etag: string }).etag)) {
      await this.remove(output.key);
      return { ...result, aborted: "an input changed during compaction" };
    }
    await mapLimit(objects, READ_CONCURRENCY, (o) => this.remove(o.key));
    return { ...result, compacted: true, output: output.key };
  }

  /** Compacts every shard of this log over the threshold. */
  async compactAll(options: CompactOptions = {}): Promise<CompactResult[]> {
    const out: CompactResult[] = [];
    for (const s of (await this.list(this.listPrefix() as string)).values())
      if (s.objects.length > (options.threshold ?? DEFAULT_COMPACT_THRESHOLD))
        out.push(await this.compact(s.key, options));
    return out;
  }
}
