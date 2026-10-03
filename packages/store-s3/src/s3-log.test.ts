import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { MemoryRecord } from "@ynm/model";
import type { ShardKey } from "@ynm/store";
import { collect, makeRecord, runRecordLogConformance } from "@ynm/store/testing";
import { openS3Log } from "./index.js";
import { isNotFound, isPreconditionFailed, type S3Command, S3Log } from "./s3-log.js";
import { MemoryS3, s3Error } from "./testing/memory-s3.js";

const buckets = new WeakMap<S3Log, MemoryS3>();
let n = 0;

function fresh(level: "personal" | "distributed" = "personal", s3 = new MemoryS3()): S3Log {
  const log = new S3Log(`s3-${level}`, level, {
    client: s3,
    bucket: "test",
    prefix: `/run-${++n}/`,
  });
  buckets.set(log, s3);
  return log;
}

function shardPrefix(log: S3Log, r: MemoryRecord): string {
  return `${log.prefix}/${r.level}/${r.namespace}/${r.type}/${r.recordedAt.slice(0, 7)}/`;
}

runRecordLogConformance("s3", {
  // A small page size makes every listing in the suite paginate.
  create: async (level) => fresh(level, new MemoryS3({ pageSize: 7 })),
  corrupt: async (log, record) => {
    const s3 = buckets.get(log as S3Log) as MemoryS3;
    s3.plant(`${shardPrefix(log as S3Log, record)}01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl`, "{broken\n");
  },
  concurrentWriters: async (log, writers, perWriter) => {
    const s3 = buckets.get(log as S3Log) as MemoryS3;
    const base = log as S3Log;
    await Promise.all(
      Array.from({ length: writers }, async (_, w) => {
        const own = new S3Log(base.id, base.level, {
          client: s3,
          bucket: base.bucket,
          prefix: base.prefix,
        });
        for (let i = 0; i < perWriter; i++)
          await own.append([
            makeRecord({ recordedAt: "2026-09-20T00:00:00.000Z", content: `w${w}-${i}` }),
          ]);
      })
    );
  },
});

const SHARD_TIME = "2026-09-20T00:00:00.000Z";

async function fill(log: S3Log, objects: number): Promise<MemoryRecord[]> {
  const recs: MemoryRecord[] = [];
  for (let i = 0; i < objects; i++) {
    const r = makeRecord({ recordedAt: SHARD_TIME });
    recs.push(r);
    await log.append([r]);
  }
  return recs;
}

/** A later line of `of`'s memory, in the same shard. */
function annotation(of: MemoryRecord): MemoryRecord {
  return {
    ...makeRecord({ recordedAt: SHARD_TIME }),
    memoryId: of.memoryId,
    op: "annotate",
    content: undefined,
    tags: ["x"],
  };
}

/**
 * Runs `race` once, the first time a `kind` command is sent, and holds every later `kind`
 * command until it finishes. Commands the race itself sends pass straight through.
 */
function racing<T>(
  s3: MemoryS3,
  kind: abstract new (...args: never[]) => S3Command,
  race: () => Promise<T>
): { result: () => Promise<T | undefined> } {
  let gate: Promise<T> | undefined;
  let inside = false;
  s3.before = async (cmd) => {
    if (inside || !(cmd instanceof kind)) return;
    gate ??= (async () => {
      inside = true;
      try {
        return await race();
      } finally {
        inside = false;
      }
    })();
    await gate;
  };
  return { result: async () => gate };
}

function noDuplicates(records: MemoryRecord[]): void {
  expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
}

describe("S3Log layout and listing", () => {
  it("writes one object per shard per append under <prefix>/<level>/<namespace>/<type>/<month>/<ulid>.jsonl", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const a = makeRecord({ recordedAt: SHARD_TIME });
    const b = makeRecord({ recordedAt: SHARD_TIME });
    const c = makeRecord({ recordedAt: SHARD_TIME, namespace: "user/test/deep/er" });
    await log.append([a, b, c]);
    const keys = s3.keys();
    expect(keys).toHaveLength(2);
    for (const k of keys)
      expect(k).toMatch(/^run-\d+\/personal\/user\/test\/.*\/2026-09\/[0-9A-Z]{26}\.jsonl$/);
    expect(keys.some((k) => k.includes("/user/test/deep/er/semantic/2026-09/"))).toBe(true);
    expect(s3.calls.filter((c) => c === "PutObjectCommand")).toHaveLength(2);
    expect(log.location).toBe(`s3://test/${log.prefix}`);
  });

  it("an empty append writes nothing", async () => {
    const s3 = new MemoryS3();
    expect(await fresh("personal", s3).append([])).toEqual({ appended: 0, shards: [] });
    expect(s3.keys()).toEqual([]);
  });

  it("paginates listings and reads every object", async () => {
    const s3 = new MemoryS3({ pageSize: 2 });
    const log = fresh("personal", s3);
    const recs = await fill(log, 9);
    s3.calls.length = 0;
    const shards = await log.shards();
    expect(shards).toHaveLength(1);
    expect(s3.calls.filter((c) => c === "ListObjectsV2Command")).toHaveLength(5);
    expect((await collect(log)).map((r) => r.id)).toEqual(recs.map((r) => r.id));
  });

  it("ignores stray keys and other levels, and works without a prefix", async () => {
    const s3 = new MemoryS3();
    const log = new S3Log("root", "personal", { client: s3, bucket: "b" });
    const r = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([r]);
    expect(s3.keys()[0]).toMatch(/^personal\/user\/test\/semantic\/2026-09\//);
    s3.plant("personal/user/test/semantic/2026-09/notes.txt", "x");
    s3.plant("personal/user/test/semantic/bad-month/01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl", "x");
    s3.plant("personal/user/test/nottype/2026-09/01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl", "x");
    s3.plant("personal/user//semantic/2026-09/01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl", "x");
    s3.plant("personal/semantic/2026-09/01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl", "x");
    s3.plant("nolevel/user/semantic/2026-09/01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl", "x");
    expect((await collect(log)).map((x) => x.id)).toEqual([r.id]);
    expect(await log.shards({ level: "distributed" })).toEqual([]);
    expect(await collect(log, { level: "distributed" })).toEqual([]);
    expect((await log.health()).ok).toBe(true);
  });

  it("revision changes on every append and previous is the revision before it", async () => {
    const log = fresh();
    const first = await log.append([makeRecord({ recordedAt: SHARD_TIME })]);
    expect(first.shards[0]?.previous).toBeNull();
    const second = await log.append([makeRecord({ recordedAt: SHARD_TIME })]);
    expect(second.shards[0]?.previous).toBe(first.shards[0]?.revision);
    expect(second.shards[0]?.revision).not.toBe(first.shards[0]?.revision);
    expect((await log.shards())[0]?.revision).toBe(second.shards[0]?.revision);
  });

  it("an object another writer lands out of key order still changes the revision", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const r = makeRecord({ recordedAt: SHARD_TIME });
    const res = await log.append([r]);
    s3.plant(
      `${shardPrefix(log, r)}00000000000000000000000000.jsonl`,
      `${JSON.stringify(makeRecord({ recordedAt: SHARD_TIME }))}\n`
    );
    expect((await log.shards())[0]?.revision).not.toBe(res.shards[0]?.revision);
  });

  it("retries an append whose key already exists", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    let planted = false;
    s3.before = (cmd) => {
      if (cmd instanceof PutObjectCommand && !planted) {
        planted = true;
        s3.plant(cmd.input.Key as string, "taken\n");
      }
    };
    const r = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([r]);
    expect(s3.keys()).toHaveLength(2);
    const problems: unknown[] = [];
    const out: MemoryRecord[] = [];
    for await (const x of log.scan(undefined, (p) => problems.push(p))) out.push(x);
    expect(out.map((x) => x.id)).toEqual([r.id]);
    expect(problems).toHaveLength(1);
  });

  it("surfaces errors that are not conflicts", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    await log.append([makeRecord()]);
    s3.before = (cmd) => {
      if (cmd instanceof GetObjectCommand) throw s3Error("AccessDenied", 403);
    };
    await expect(collect(log)).rejects.toThrow(/AccessDenied/);
    const health = await log.health();
    expect(health.ok).toBe(false);
    expect(health.problems[0]).toMatch(/^s3:\/\/test\/run-\d+: AccessDenied/);
    s3.before = (cmd) => {
      if (cmd instanceof PutObjectCommand) throw s3Error("AccessDenied", 403);
    };
    await expect(log.append([makeRecord()])).rejects.toThrow(/AccessDenied/);
  });

  it("classifies S3 errors", () => {
    expect(isPreconditionFailed(s3Error("PreconditionFailed", 412))).toBe(true);
    expect(isPreconditionFailed(s3Error("ConditionalRequestConflict", 409))).toBe(true);
    expect(isPreconditionFailed({ name: "PreconditionFailed" })).toBe(true);
    expect(isPreconditionFailed(new Error("x"))).toBe(false);
    expect(isPreconditionFailed(null)).toBe(false);
    expect(isNotFound(s3Error("NoSuchKey", 404))).toBe(true);
    expect(isNotFound({ name: "NotFound" })).toBe(true);
    expect(isNotFound(s3Error("AccessDenied", 403))).toBe(false);
  });
});

describe("S3Log documents", () => {
  it("keeps a document at <prefix>/documents/<name>.json, versioned by its ETag", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const version = await log.writeDocument("people", "{}", null);
    expect(s3.keys()).toEqual([`${log.prefix}/documents/people.json`]);
    expect(version).toMatch(/^".+"$/);
    expect(await log.readDocument("people")).toEqual({ text: "{}", version });
    await log.append([makeRecord({ recordedAt: SHARD_TIME })]);
    expect(await log.shards()).toHaveLength(1);
    expect((await log.health()).details).toMatchObject({ shards: 1, objects: 1 });
  });

  it("sends If-None-Match to create and If-Match to replace", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const sent: Array<Record<string, unknown>> = [];
    s3.before = (c) => {
      if (c instanceof PutObjectCommand) sent.push({ ...c.input });
    };
    const v1 = (await log.writeDocument("people", "[1]", null)) as string;
    await log.writeDocument("people", "[2]", v1);
    expect(sent[0]).toMatchObject({ IfNoneMatch: "*" });
    expect(sent[0]?.IfMatch).toBeUndefined();
    expect(sent[1]).toMatchObject({ IfMatch: v1 });
  });

  it("treats a replaced-but-deleted document as a lost race and surfaces other errors", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    expect(await log.writeDocument("people", "[]", '"gone"')).toBeNull();
    s3.before = () => {
      throw s3Error("AccessDenied", 403);
    };
    await expect(log.writeDocument("people", "[]", null)).rejects.toThrow(/AccessDenied/);
  });
});

describe("S3Log health", () => {
  it("reports counts, bad lines with their object, and versioning", async () => {
    const s3 = new MemoryS3({ versioned: true });
    const log = fresh("personal", s3);
    const r = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([r, makeRecord({ recordedAt: SHARD_TIME })]);
    let health = await log.health();
    expect(health).toMatchObject({
      ok: true,
      details: { bucket: "test", shards: 1, objects: 1, records: 2, versioning: "Enabled" },
    });
    s3.plant(
      `${shardPrefix(log, r)}01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl`,
      `${JSON.stringify(r)}\nnot json\n`
    );
    health = await log.health();
    expect(health.ok).toBe(false);
    expect(health.problems).toEqual([
      expect.stringMatching(/^personal\/user\/test\/semantic\/2026-09\/01Z+\.jsonl:2 invalid JSON/),
    ]);
    expect(health.details).toMatchObject({ objects: 2, records: 2 });
  });

  it("says Disabled for an unversioned bucket and unknown when it may not ask", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    expect(await log.versioning()).toBe("Disabled");
    s3.before = () => {
      throw s3Error("AccessDenied", 403);
    };
    expect(await log.versioning()).toBe("unknown");
  });
});

describe("S3Log purge", () => {
  it("rewrites in place, deletes emptied objects, and changes the shard revision", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const keep = makeRecord({ recordedAt: SHARD_TIME });
    const gone = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([keep, gone]);
    await log.append([annotation(gone)]);
    const before = (await log.shards())[0]?.revision;
    expect(s3.keys()).toHaveLength(2);
    const res = await log.purge(gone.memoryId);
    expect(res.removed).toBe(2);
    expect(s3.keys()).toHaveLength(1);
    expect((await collect(log)).map((r) => r.id)).toEqual([keep.id]);
    expect((await log.shards())[0]?.revision).not.toBe(before);
  });

  it("retries a rewrite when the object changed under it (412)", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const keep = makeRecord({ recordedAt: SHARD_TIME });
    const gone = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([keep, gone]);
    const key = s3.keys()[0] as string;
    const late = makeRecord({ recordedAt: SHARD_TIME });
    let raced = 0;
    s3.before = (cmd) => {
      if (cmd instanceof PutObjectCommand && cmd.input.IfMatch && raced === 0) {
        raced += 1;
        // Another purge rewrote the object first: its ETag no longer matches.
        s3.plant(
          key,
          `${JSON.stringify(keep)}\n${JSON.stringify(gone)}\n${JSON.stringify(late)}\n`
        );
      }
    };
    const res = await log.purge(gone.memoryId);
    expect(raced).toBe(1);
    expect(res.removed).toBe(1);
    expect((await collect(log)).map((r) => r.id)).toEqual([keep.id, late.id]);
  });

  it("gives up after repeated conflicts rather than loop forever", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const gone = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([gone, makeRecord({ recordedAt: SHARD_TIME })]);
    s3.before = (cmd) => {
      if (cmd instanceof PutObjectCommand && cmd.input.IfMatch)
        throw s3Error("PreconditionFailed", 412);
    };
    await expect(log.purge(gone.memoryId)).rejects.toThrow(/PreconditionFailed/);
  });

  it("keeps bad lines, which belong to no memory", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const gone = makeRecord({ recordedAt: SHARD_TIME });
    s3.plant(
      `${shardPrefix(log, gone)}01ZZZZZZZZZZZZZZZZZZZZZZZZ.jsonl`,
      `${JSON.stringify(gone)}\n{broken\n`
    );
    expect((await log.purge(gone.memoryId)).removed).toBe(1);
    expect(s3.objects.get(s3.keys()[0] as string)?.at(-1)?.body).toBe("{broken\n");
  });

  it("with forgetHistory drops noncurrent versions and delete markers on a versioned bucket", async () => {
    const s3 = new MemoryS3({ versioned: true, pageSize: 1 });
    const log = fresh("personal", s3);
    const keep = makeRecord({ recordedAt: SHARD_TIME });
    const gone = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([keep, gone]);
    await log.append([annotation(gone)]);
    const [mixed, emptied] = s3.keys();
    await log.purge(gone.memoryId, { forgetHistory: true });
    const mixedVersions = s3.objects.get(mixed as string) ?? [];
    expect(mixedVersions).toHaveLength(1);
    expect(mixedVersions[0]?.body).not.toContain(gone.memoryId);
    expect(s3.objects.has(emptied as string)).toBe(false);
  });

  it("without forgetHistory leaves the old versions", async () => {
    const s3 = new MemoryS3({ versioned: true });
    const log = fresh("personal", s3);
    const gone = makeRecord({ recordedAt: SHARD_TIME });
    await log.append([gone, makeRecord({ recordedAt: SHARD_TIME })]);
    await log.purge(gone.memoryId);
    expect(s3.objects.get(s3.keys()[0] as string)).toHaveLength(2);
  });

  it("finds lines a racing compaction moved into a new object", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const recs = await fill(log, 5);
    const target = recs[2] as MemoryRecord;
    const shard = (await log.shards())[0] as ShardKey;
    // Purge is about to read an object: a compaction gets in first and moves every line.
    const race = racing(s3, GetObjectCommand, () => log.compact(shard, { threshold: 1 }));
    expect((await log.purge(target.memoryId)).removed).toBe(1);
    expect((await race.result())?.compacted).toBe(true);
    const left = await collect(log);
    expect(left.map((r) => r.id)).toEqual(recs.filter((r) => r !== target).map((r) => r.id));
  });
});

describe("S3Log compaction", () => {
  it("leaves a shard at or under the threshold alone", async () => {
    const log = fresh();
    await fill(log, 3);
    const shard = (await log.shards())[0] as ShardKey;
    expect(await log.compact(shard, { threshold: 3 })).toMatchObject({
      compacted: false,
      inputs: 3,
    });
    expect(await log.compactAll()).toEqual([]);
  });

  it("folds a shard over the default threshold into one object, keeping every record once", async () => {
    const s3 = new MemoryS3({ pageSize: 10 });
    const log = fresh("personal", s3);
    const recs = await fill(log, 33);
    s3.plant(
      `${shardPrefix(log, recs[0] as MemoryRecord)}00000000000000000000000000.jsonl`,
      `${JSON.stringify(recs[0])}\n{broken\n{broken\n`
    );
    const before = (await log.shards())[0]?.revision;
    const [result] = await log.compactAll();
    expect(result).toMatchObject({ compacted: true, inputs: 34 });
    expect(s3.keys()).toEqual([result?.output]);
    const problems: unknown[] = [];
    const back: MemoryRecord[] = [];
    for await (const r of log.scan(undefined, (p) => problems.push(p))) back.push(r);
    expect(back.map((r) => r.id).sort()).toEqual(recs.map((r) => r.id).sort());
    expect(problems).toHaveLength(1);
    expect((await log.shards())[0]?.revision).not.toBe(before);
  });

  it("a reader between the write and the deletes sees no duplicates", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const recs = await fill(log, 6);
    const shard = (await log.shards())[0] as ShardKey;
    let objects = 0;
    // Every delete waits while a full scan runs against the new object plus all the inputs.
    const race = racing(s3, DeleteObjectCommand, () => {
      objects = s3.keys().length;
      return collect(log);
    });
    expect((await log.compact(shard, { threshold: 2 })).compacted).toBe(true);
    expect(objects).toBe(7);
    const during = (await race.result()) as MemoryRecord[];
    noDuplicates(during);
    expect(during).toHaveLength(recs.length);
  });

  it("a reader whose objects vanish mid-scan relists and loses nothing", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const recs = await fill(log, 6);
    const shard = (await log.shards())[0] as ShardKey;
    // The scan has listed; the whole compaction runs before it reads anything.
    const race = racing(s3, GetObjectCommand, () => log.compact(shard, { threshold: 2 }));
    const back = await collect(log);
    expect((await race.result())?.compacted).toBe(true);
    noDuplicates(back);
    expect(back.map((r) => r.id).sort()).toEqual(recs.map((r) => r.id).sort());
  });

  it("backs off when a purge rewrites an input during compaction", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    const recs = await fill(log, 4);
    const target = recs[1] as MemoryRecord;
    const shard = (await log.shards())[0] as ShardKey;
    // Compaction has read its inputs; the purge runs before the merged object is written.
    racing(s3, PutObjectCommand, () => log.purge(target.memoryId));
    const res = await log.compact(shard, { threshold: 2 });
    expect(res).toMatchObject({ compacted: false, aborted: expect.stringMatching(/changed/) });
    const left = await collect(log);
    expect(left.map((r) => r.id)).not.toContain(target.id);
    expect(left).toHaveLength(3);
  });

  it("backs off when an input vanished before it was read", async () => {
    const s3 = new MemoryS3();
    const log = fresh("personal", s3);
    await fill(log, 4);
    const victim = s3.keys()[0] as string;
    s3.before = (cmd) => {
      if (cmd instanceof GetObjectCommand && cmd.input.Key === victim) s3.objects.delete(victim);
    };
    const res = await log.compact((await log.shards())[0] as ShardKey, { threshold: 2 });
    expect(res).toMatchObject({ compacted: false, aborted: expect.stringMatching(/vanished/) });
  });
});

describe("openS3Log", () => {
  it("builds an S3Log over the SDK client without touching the network", () => {
    const log = openS3Log("hosted", "distributed", {
      bucket: "b",
      prefix: "stores/one",
      region: "eu-west-2",
    });
    expect(log).toBeInstanceOf(S3Log);
    expect(log.location).toBe("s3://b/stores/one");
    expect(openS3Log("x", "personal", { bucket: "b" }).prefix).toBe("");
  });
});
