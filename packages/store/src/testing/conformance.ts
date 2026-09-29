import type { MemoryRecord } from "@ynm/model";
import { ulid } from "@ynm/model";
import { describe, expect, it } from "vitest";
import { fold } from "../fold.js";
import type { RecordLog } from "../log.js";

export interface ConformanceOptions {
  /** Builds a fresh, empty log at the given level. */
  create: (level: "personal" | "distributed") => Promise<RecordLog>;
  /** Optional: write raw bytes into a shard so tolerant parsing can be exercised. */
  corrupt?: (log: RecordLog, record: MemoryRecord) => Promise<void>;
  /** Optional: spawn `n` external writers that each append `perWriter` records to this log. */
  concurrentWriters?: (log: RecordLog, n: number, perWriter: number) => Promise<void>;
}

let clock = Date.parse("2026-09-01T00:00:00.000Z");
export function nextTime(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

export function makeRecord(over: Partial<MemoryRecord> = {}): MemoryRecord {
  const id = ulid(clock + 1);
  return {
    v: 1,
    id,
    memoryId: id,
    op: "create",
    type: "semantic",
    level: "personal",
    namespace: "user/test",
    tags: [],
    links: [],
    content: `memory ${id}`,
    recordedAt: nextTime(),
    provenance: { actor: "conformance" },
    ...over,
  };
}

export async function collect(
  log: RecordLog,
  filter?: Parameters<RecordLog["scan"]>[0]
): Promise<MemoryRecord[]> {
  const out: MemoryRecord[] = [];
  for await (const r of log.scan(filter)) out.push(r);
  return out;
}

/**
 * The behaviour every RecordLog provider must satisfy (ADR-004). Providers call this from
 * their own test file with a factory.
 */
export function runRecordLogConformance(name: string, opts: ConformanceOptions): void {
  describe(`RecordLog conformance: ${name}`, () => {
    it("starts empty and reports healthy", async () => {
      const log = await opts.create("personal");
      expect(await collect(log)).toEqual([]);
      expect(await log.shards()).toEqual([]);
      expect((await log.health()).ok).toBe(true);
    });

    it("appends and scans back identical records", async () => {
      const log = await opts.create("personal");
      const recs = [
        makeRecord(),
        makeRecord({ type: "episodic" }),
        makeRecord({ namespace: "user/test/sub" }),
      ];
      const res = await log.append(recs);
      expect(res.appended).toBe(3);
      expect(res.shards).toHaveLength(3);
      const back = await collect(log);
      expect(back.map((r) => r.id).sort()).toEqual(recs.map((r) => r.id).sort());
      expect(back.find((r) => r.id === recs[0]?.id)).toEqual(recs[0]);
    });

    it("partitions into level/namespace/type/month shards and filters them", async () => {
      const log = await opts.create("personal");
      await log.append([
        makeRecord({ recordedAt: "2026-08-15T00:00:00.000Z" }),
        makeRecord({ recordedAt: "2026-09-15T00:00:00.000Z" }),
        makeRecord({ recordedAt: "2026-09-16T00:00:00.000Z", type: "procedural" }),
        makeRecord({ recordedAt: "2026-09-16T00:00:00.000Z", namespace: "other" }),
      ]);
      const shards = await log.shards();
      expect(shards.map((s) => `${s.namespace}/${s.type}/${s.bucket}`).sort()).toEqual([
        "other/semantic/2026-09",
        "user/test/procedural/2026-09",
        "user/test/semantic/2026-08",
        "user/test/semantic/2026-09",
      ]);
      expect(await collect(log, { namespace: "user/test" })).toHaveLength(3);
      expect(await collect(log, { type: "procedural" })).toHaveLength(1);
      expect(await collect(log, { fromBucket: "2026-09" })).toHaveLength(3);
      expect(await collect(log, { namespace: "user" })).toHaveLength(3);
      expect(await collect(log, { namespace: "use" })).toHaveLength(0);
    });

    it("refuses records of the wrong level (ADR-001, ADR-007)", async () => {
      const log = await opts.create("distributed");
      await expect(log.append([makeRecord({ level: "personal" })])).rejects.toThrow(
        /refusing a personal record/
      );
      expect(await collect(log)).toEqual([]);
    });

    it("appends are durable across sequential calls and fold correctly", async () => {
      const log = await opts.create("personal");
      const c = makeRecord();
      await log.append([c]);
      const s: MemoryRecord = {
        ...makeRecord(),
        memoryId: c.memoryId,
        op: "supersede",
        content: "v2",
        links: [{ rel: "supersedes", to: c.memoryId }],
      };
      await log.append([s]);
      const { memories } = fold(await collect(log));
      expect(memories.get(c.memoryId)?.current.content).toBe("v2");
    });

    it("survives many appends to one shard without loss", async () => {
      const log = await opts.create("personal");
      const recs = Array.from({ length: 200 }, () =>
        makeRecord({ recordedAt: "2026-09-20T00:00:00.000Z" })
      );
      for (let i = 0; i < recs.length; i += 10) await log.append(recs.slice(i, i + 10));
      expect((await collect(log)).length).toBe(200);
    });

    it("purges every line of a memory and nothing else (ADR-002)", async () => {
      const log = await opts.create("personal");
      const keep = makeRecord();
      const gone = makeRecord();
      const later: MemoryRecord = {
        ...makeRecord(),
        memoryId: gone.memoryId,
        op: "annotate",
        content: undefined,
        tags: ["x"],
      };
      await log.append([keep, gone, later]);
      const res = await log.purge(gone.memoryId);
      expect(res.removed).toBe(2);
      expect(res.shards.length).toBeGreaterThan(0);
      expect((await collect(log)).map((r) => r.id)).toEqual([keep.id]);
      expect((await log.purge("nope")).removed).toBe(0);
    });

    if (opts.corrupt) {
      const corrupt = opts.corrupt;
      it("skips and reports a corrupt line, never fatal (NFR-7)", async () => {
        const log = await opts.create("personal");
        const good = makeRecord();
        await log.append([good]);
        await corrupt(log, good);
        const problems: unknown[] = [];
        const out: MemoryRecord[] = [];
        for await (const r of log.scan(undefined, (p) => problems.push(p))) out.push(r);
        expect(out.map((r) => r.id)).toEqual([good.id]);
        expect(problems).toHaveLength(1);
        expect((await log.health()).ok).toBe(false);
      });
    }

    if (opts.concurrentWriters) {
      const spawn = opts.concurrentWriters;
      it("loses nothing under concurrent external writers (NFR-1)", async () => {
        const log = await opts.create("personal");
        await spawn(log, 6, 15);
        expect((await collect(log)).length).toBe(90);
      }, 120_000);
    }
  });
}
