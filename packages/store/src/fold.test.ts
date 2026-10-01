import type { MemoryRecord } from "@ynm/model";
import { ulid } from "@ynm/model";
import {
  applyRecord,
  compareRecords,
  Folder,
  fold,
  foldWithSnapshot,
  memoryFromBase,
  snapshotData,
} from "./fold.js";

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

describe("compareRecords", () => {
  it("orders by recordedAt, then id, and treats the same id as equal", () => {
    const a = { ...create(), id: "01ARZ3NDEKTSV4RRFFQ69G5FAA" };
    const sameTime = { ...a, id: "01ARZ3NDEKTSV4RRFFQ69G5FAB" };
    const later = create();
    expect(compareRecords(a, later)).toBe(-1);
    expect(compareRecords(later, a)).toBe(1);
    expect(compareRecords(a, sameTime)).toBe(-1);
    expect(compareRecords(sameTime, a)).toBe(1);
    expect(compareRecords(a, { ...a })).toBe(0);
  });
});

describe("applyRecord field updates", () => {
  it("supersede replaces type, namespace, subject and every annotated field it sets", () => {
    const c = create({
      subject: "entity:old",
      links: [{ rel: "about", to: "01M00000000000000000000AAA" }],
    });
    const s = on(c, "supersede", {
      type: "procedural",
      namespace: "user/x",
      subject: "entity:new",
      importance: 0.9,
      confidence: 0.6,
      pinned: true,
      needsReview: true,
      links: [
        { rel: "about", to: "01M00000000000000000000AAA" },
        { rel: "supersedes", to: c.memoryId },
      ],
    });
    const m = fold([c, s]).memories.get(c.memoryId);
    expect(m).toMatchObject({
      type: "procedural",
      namespace: "user/x",
      subject: "entity:new",
      importance: 0.9,
      confidence: 0.6,
      pinned: true,
      needsReview: true,
    });
    // The duplicate link is merged, not repeated.
    expect(m?.links).toEqual([
      { rel: "about", to: "01M00000000000000000000AAA" },
      { rel: "supersedes", to: c.memoryId },
    ]);
  });

  it("supersede without a subject or annotations keeps the earlier values", () => {
    const c = create({ subject: "entity:keep", confidence: 0.7, pinned: true, needsReview: true });
    const s = on(c, "supersede");
    const m = fold([c, s]).memories.get(c.memoryId);
    expect(m).toMatchObject({
      subject: "entity:keep",
      importance: 0.4,
      confidence: 0.7,
      pinned: true,
      needsReview: true,
    });
  });

  it("annotate sets subject and confidence and can unpin", () => {
    const c = create({ pinned: true });
    const a = on(c, "annotate", { subject: "entity:x", confidence: 0.3, pinned: false });
    const m = fold([c, a]).memories.get(c.memoryId);
    expect(m).toMatchObject({ subject: "entity:x", confidence: 0.3, pinned: false });
  });

  it("an annotate without fields only counts as a version", () => {
    const c = create({ subject: "entity:s" });
    const m = fold([c, on(c, "annotate")]).memories.get(c.memoryId);
    expect(m).toMatchObject({ subject: "entity:s", importance: 0.4, versions: 2 });
  });

  it("a snapshot record applied directly changes nothing but the version count", () => {
    const c = create();
    const m = memoryFromBase(c);
    const before = structuredClone(m);
    const snap = on(c, "snapshot");
    applyRecord(m, snap);
    expect(m).toEqual({ ...before, versions: 2, updatedAt: snap.recordedAt });
  });

  it("a plain fold skips snapshot records", () => {
    const c = create();
    const snap = { ...on(c, "snapshot"), memoryId: "01M0000000000000000000SNAP" };
    const r = fold([c, snap]);
    expect([...r.memories.keys()]).toEqual([c.memoryId]);
    expect(r.orphans).toEqual([]);
  });
});

describe("records that arrive before their base", () => {
  function earlier(base: MemoryRecord, r: MemoryRecord, ms = 500): MemoryRecord {
    return { ...r, recordedAt: new Date(Date.parse(base.recordedAt) - ms).toISOString() };
  }

  it("fill fields the base leaves unset and move createdAt back", () => {
    const c = create({ importance: undefined, tags: ["base"] });
    const a = earlier(
      c,
      on(c, "annotate", {
        subject: "entity:early",
        importance: 0.8,
        confidence: 0.5,
        pinned: true,
        needsReview: true,
        tags: ["early"],
        links: [{ rel: "about", to: "01M00000000000000000000AAA" }],
      })
    );
    const m = fold([c, a]).memories.get(c.memoryId);
    expect(m).toMatchObject({
      subject: "entity:early",
      importance: 0.8,
      confidence: 0.5,
      pinned: true,
      needsReview: true,
      createdAt: a.recordedAt,
      versions: 2,
    });
    expect(m?.tags).toEqual(["early", "base"]);
    expect(m?.links).toEqual([{ rel: "about", to: "01M00000000000000000000AAA" }]);
  });

  it("never override fields the base sets", () => {
    const c = create({
      subject: "entity:base",
      importance: 0.2,
      confidence: 0.9,
      pinned: false,
      needsReview: false,
    });
    const a = earlier(
      c,
      on(c, "annotate", {
        subject: "entity:early",
        importance: 0.8,
        confidence: 0.1,
        pinned: true,
        needsReview: true,
      })
    );
    const m = fold([c, a]).memories.get(c.memoryId);
    expect(m).toMatchObject({
      subject: "entity:base",
      importance: 0.2,
      confidence: 0.9,
      pinned: false,
      needsReview: false,
    });
  });

  it("count purge markers as versions without changing state", () => {
    const c = create();
    const p = earlier(c, on(c, "purge-marker", { reason: "gdpr" }));
    const m = fold([c, p]).memories.get(c.memoryId);
    expect(m?.versions).toBe(2);
    expect(m?.tombstoned).toBe(false);
    expect(m?.createdAt).toBe(p.recordedAt);
  });

  it("keep createdAt when the early record shares the base's timestamp", () => {
    const c = create();
    // Same recordedAt, smaller id: sorted ahead of the create, so it is applied as "before".
    const a = {
      ...on(c, "annotate", { tags: ["tie"] }),
      id: "00000000000000000000000000",
      recordedAt: c.recordedAt,
    };
    const m = fold([c, a]).memories.get(c.memoryId);
    expect(m?.createdAt).toBe(c.recordedAt);
    expect(m?.tags).toEqual(["tie", "a"]);
    expect(m?.versions).toBe(2);
  });
});

describe("foldWithSnapshot edge cases", () => {
  it("treats a snapshot without data as empty", () => {
    const c = create();
    const snap: MemoryRecord = { ...create(), op: "snapshot", data: undefined, content: undefined };
    const r = foldWithSnapshot(snap, [c]);
    expect(r.memories.size).toBe(0); // c is older than the snapshot and is skipped
    const later = create();
    expect([...foldWithSnapshot(snap, [later]).memories.keys()]).toEqual([later.memoryId]);
  });

  it("resolves several carried orphans once their base arrives", () => {
    const c = create();
    const a1 = on(c, "annotate", { tags: ["one"] });
    const a2 = on(c, "annotate", { tags: ["two"] });
    const before = fold([a1, a2]);
    expect(before.orphans).toHaveLength(2);
    const snap: MemoryRecord = {
      ...create(),
      op: "snapshot",
      content: undefined,
      data: snapshotData(before),
    };
    const base = create({ id: c.id, memoryId: c.memoryId });
    const r = foldWithSnapshot(snap, [base]);
    expect(r.orphans).toEqual([]);
    expect(r.memories.get(c.memoryId)).toEqual(fold([a1, a2, base]).memories.get(c.memoryId));
    expect(r.memories.get(c.memoryId)?.versions).toBe(3);
  });
});

describe("Folder orphans", () => {
  it("keeps orphans pending across batches and resolves them when the base arrives", () => {
    const c = create();
    const a1 = on(c, "annotate", { tags: ["x"] });
    const a2 = on(c, "annotate", { tags: ["y"] });
    const f = new Folder();
    expect(f.add([a1])).toEqual([]);
    expect(f.add([a2])).toEqual([]);
    expect(f.result().orphans.map((o) => o.id)).toEqual([a1.id, a2.id]);
    expect(f.get(c.memoryId)).toBeUndefined();
    expect(f.add([c])).toEqual([c.memoryId]);
    expect(f.get(c.memoryId)?.tags).toEqual(["a", "x", "y"]);
    expect(f.result().orphans).toEqual([]);
  });

  it("ignores records it has already seen", () => {
    const c = create();
    const f = new Folder();
    f.add([c]);
    expect(f.add([c])).toEqual([]);
    expect(f.get(c.memoryId)?.versions).toBe(1);
  });
});
