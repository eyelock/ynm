import type { MemoryRecord } from "@ynm/model";
import { ulid } from "@ynm/model";
import { Folder, fold, foldWithSnapshot, snapshotData } from "./fold.js";

let t = 1_000_000;
function at(): string {
  t += 1000;
  return new Date(t).toISOString();
}
function create(over: Partial<MemoryRecord> = {}): MemoryRecord {
  const id = ulid(t);
  return {
    v: 1,
    id,
    memoryId: id,
    op: "create",
    type: "semantic",
    level: "personal",
    namespace: "common",
    tags: ["a"],
    links: [],
    content: "v1",
    importance: 0.4,
    recordedAt: at(),
    provenance: { actor: "t" },
    ...over,
  };
}
function on(
  m: MemoryRecord,
  op: MemoryRecord["op"],
  over: Partial<MemoryRecord> = {}
): MemoryRecord {
  return {
    ...create(),
    id: ulid(t),
    memoryId: m.memoryId,
    op,
    content: op === "supersede" ? "v2" : undefined,
    links: op === "supersede" ? [{ rel: "supersedes", to: m.memoryId }] : [],
    tags: [],
    importance: undefined,
    recordedAt: at(),
    ...over,
  };
}

describe("fold (ADR-002)", () => {
  it("latest supersede wins and keeps merged tags and links", () => {
    const c = create();
    const s = on(c, "supersede", { tags: ["b"] });
    const { memories } = fold([s, c]);
    const m = memories.get(c.memoryId);
    expect(m?.current.content).toBe("v2");
    expect(m?.tags).toEqual(["a", "b"]);
    expect(m?.links).toEqual([{ rel: "supersedes", to: c.memoryId }]);
    expect(m?.versions).toBe(2);
  });

  it("tombstone hides; a later supersede revives", () => {
    const c = create();
    const tomb = on(c, "tombstone", { reason: "wrong" });
    expect(fold([c, tomb]).memories.get(c.memoryId)?.tombstoned).toBe(true);
    const s = on(c, "supersede");
    expect(fold([c, tomb, s]).memories.get(c.memoryId)?.tombstoned).toBe(false);
  });

  it("annotate changes importance, pinned, review and adds tags without touching content", () => {
    const c = create();
    const a = on(c, "annotate", { importance: 0.9, pinned: true, needsReview: true, tags: ["z"] });
    const m = fold([c, a]).memories.get(c.memoryId);
    expect(m?.current.content).toBe("v1");
    expect(m?.importance).toBe(0.9);
    expect(m?.pinned).toBe(true);
    expect(m?.needsReview).toBe(true);
    expect(m?.tags).toEqual(["a", "z"]);
  });

  it("is order independent", () => {
    const c = create();
    const a = on(c, "annotate", { tags: ["x"] });
    const s = on(c, "supersede");
    const forward = fold([c, a, s]);
    const shuffled = fold([s, c, a]);
    expect(shuffled.memories.get(c.memoryId)).toEqual(forward.memories.get(c.memoryId));
  });

  it("holds records that arrive before their create and applies them once it appears", () => {
    const c = create();
    const a = on(c, "annotate", { pinned: true });
    const r = fold([a, c]);
    expect(r.orphans).toHaveLength(0);
    expect(r.memories.get(c.memoryId)?.pinned).toBe(true);
  });

  it("a tombstone that precedes the base hides after a create but not after a supersede", () => {
    const c = create();
    const tombEarly = {
      ...on(c, "tombstone"),
      recordedAt: new Date(Date.parse(c.recordedAt) - 500).toISOString(),
    };
    expect(fold([c, tombEarly]).memories.get(c.memoryId)?.tombstoned).toBe(true);
    const s = on(c, "supersede");
    const tombBeforeS = {
      ...on(c, "tombstone"),
      recordedAt: new Date(Date.parse(s.recordedAt) - 100).toISOString(),
    };
    const r = fold([s, tombBeforeS]);
    expect(r.memories.get(c.memoryId)?.tombstoned).toBe(false);
    expect(r.memories.get(c.memoryId)?.versions).toBe(2);
  });

  it("reports true orphans", () => {
    const ghost = on(create(), "annotate");
    expect(fold([ghost]).orphans).toHaveLength(1);
  });

  it("purge-marker and a duplicate create change nothing", () => {
    const c = create();
    const dup = { ...c, id: ulid(t), recordedAt: at() };
    const p = on(c, "purge-marker", { reason: "gdpr" });
    const m = fold([c, dup, p]).memories.get(c.memoryId);
    expect(m?.current.id).toBe(c.id);
    expect(m?.versions).toBe(3);
  });

  it("Folder folds incrementally to the same state as a full fold", () => {
    const c1 = create();
    const c2 = create();
    const a = on(c1, "annotate", { tags: ["late"] });
    const s = on(c2, "supersede");
    const tomb = on(c1, "tombstone");
    const f = new Folder();
    expect(f.add([c1]).sort()).toEqual([c1.memoryId]);
    f.add([s, tomb]);
    f.add([c2, a]);
    f.add([a]);
    const full = fold([c1, c2, a, s, tomb]);
    expect([...f.result().memories.entries()].sort()).toEqual([...full.memories.entries()].sort());
    expect(f.result().orphans).toEqual([]);
    expect(f.size).toBe(2);
  });

  it("snapshot plus tail equals full fold", () => {
    const c1 = create();
    const c2 = create({ namespace: "user/x" });
    const a = on(c1, "annotate", { tags: ["q"] });
    const before = fold([c1, c2, a]);
    const snap: MemoryRecord = {
      ...create({ type: "reflective" }),
      op: "snapshot",
      content: undefined,
      data: snapshotData(before),
      recordedAt: at(),
    };
    const s = on(c1, "supersede");
    const c3 = create();
    const tomb = on(c2, "tombstone");
    const full = fold([c1, c2, a, s, c3, tomb, snap]);
    const fast = foldWithSnapshot(snap, [s, c3, tomb, a]);
    expect([...fast.memories.entries()]).toEqual([...full.memories.entries()]);
  });
});
