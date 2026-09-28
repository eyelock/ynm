import type { MemoryRecord } from "@ynm/model";
import { ulid } from "@ynm/model";
import { fold, foldWithSnapshot, parseJsonl, serializeJsonl, snapshotData } from "@ynm/store";
import fc from "fast-check";

/** Builds a random but valid op sequence over a small set of memories (ADR-002 semantics). */
const opSequence = fc
  .array(
    fc.record({
      mem: fc.integer({ min: 0, max: 4 }),
      op: fc.constantFrom("create", "supersede", "annotate", "tombstone", "purge-marker"),
      tag: fc.constantFrom("a", "b", "c"),
      importance: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
      pinned: fc.option(fc.boolean(), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 40 }
  )
  .map((steps) => {
    const ids = Array.from({ length: 5 }, (_, i) => ulid(1_000_000 + i));
    let t = 1_700_000_000_000;
    const out: MemoryRecord[] = [];
    for (const s of steps) {
      t += 1000;
      const memoryId = ids[s.mem] as string;
      const id = s.op === "create" ? memoryId : ulid(t);
      out.push({
        v: 1,
        id,
        memoryId,
        op: s.op as MemoryRecord["op"],
        type: "semantic",
        level: "personal",
        namespace: "user/x",
        tags: [s.tag],
        links: s.op === "supersede" ? [{ rel: "supersedes", to: memoryId }] : [],
        content: s.op === "create" || s.op === "supersede" ? `content-${t}` : undefined,
        importance: s.importance,
        pinned: s.pinned,
        recordedAt: new Date(t).toISOString(),
        provenance: { actor: "prop" },
      });
    }
    // creates share the memory's id, so a second create for the same memory collides; keep the first
    const seen = new Set<string>();
    return out.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  });

function summary(records: MemoryRecord[]) {
  return [...fold(records).memories.values()].map((m) => ({
    id: m.memoryId,
    content: m.current.content,
    tags: [...m.tags].sort(),
    importance: m.importance,
    pinned: m.pinned,
    tombstoned: m.tombstoned,
    versions: m.versions,
  }));
}

describe("fold properties (ADR-002)", () => {
  it("is independent of record order", () => {
    fc.assert(
      fc.property(opSequence, fc.infiniteStream(fc.nat()), (records, shuffle) => {
        const shuffled = [...records];
        const it = shuffle[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (it.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j] as MemoryRecord, shuffled[i] as MemoryRecord];
        }
        expect(summary(shuffled)).toEqual(summary(records));
      })
    );
  });

  it("latest supersede wins, tombstone hides unless superseded later", () => {
    fc.assert(
      fc.property(opSequence, (records) => {
        const { memories } = fold(records);
        for (const m of memories.values()) {
          const mine = records
            .filter((r) => r.memoryId === m.memoryId)
            .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
          const contentOps = mine.filter((r) => r.op === "create" || r.op === "supersede");
          const lastSupersede = [...contentOps].reverse().find((r) => r.op === "supersede");
          expect(m.current.id).toBe((lastSupersede ?? contentOps[0])?.id);
          const lastTomb = [...mine].reverse().find((r) => r.op === "tombstone");
          const expectTomb =
            !!lastTomb && (!lastSupersede || lastTomb.recordedAt > lastSupersede.recordedAt);
          expect(m.tombstoned).toBe(expectTomb);
        }
      })
    );
  });

  it("survives cat_sort_uniq: sorted, deduplicated lines fold identically", () => {
    fc.assert(
      fc.property(opSequence, (records) => {
        const lines = serializeJsonl(records).split("\n").filter(Boolean);
        const merged = [...new Set([...lines, ...lines])].sort().join("\n");
        expect(summary(parseJsonl(`${merged}\n`).records)).toEqual(summary(records));
      })
    );
  });

  it("snapshot plus tail equals the full fold", () => {
    fc.assert(
      fc.property(opSequence, fc.nat(), (records, cutRaw) => {
        const sorted = [...records].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
        const cut = sorted.length ? cutRaw % sorted.length : 0;
        const head = sorted.slice(0, cut);
        const tail = sorted.slice(cut);
        const at = head.length
          ? (head[head.length - 1] as MemoryRecord).recordedAt
          : "2000-01-01T00:00:00.000Z";
        const snap: MemoryRecord = {
          v: 1,
          id: ulid(Date.parse(at) + 1),
          memoryId: ulid(Date.parse(at) + 1),
          op: "snapshot",
          type: "reflective",
          level: "personal",
          namespace: "user/x",
          tags: [],
          links: [],
          data: snapshotData(fold(head)),
          recordedAt: new Date(Date.parse(at) + 1).toISOString(),
          provenance: { actor: "snap" },
        };
        const full = fold([...records, snap]);
        const fast = foldWithSnapshot(snap, tail);
        const norm = (r: ReturnType<typeof fold>) =>
          [...r.memories.values()]
            .map((m) => ({ ...m, current: m.current.id }))
            .sort((a, b) => (a.memoryId < b.memoryId ? -1 : 1));
        expect(norm(fast)).toEqual(norm(full));
      })
    );
  });
});
