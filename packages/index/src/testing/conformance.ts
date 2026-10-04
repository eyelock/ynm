import { describe, expect, it } from "vitest";
import type { IndexedMemory, MemoryIndex } from "../types.js";

let n = 0;
export function doc(over: Partial<IndexedMemory> = {}): IndexedMemory {
  n += 1;
  const id = `01M000000000000000000${String(n).padStart(5, "0")}`;
  return {
    memoryId: id,
    mount: "personal",
    type: "semantic",
    level: "personal",
    namespace: "user/test",
    tags: [],
    dataKeys: [],
    importance: 0.5,
    confidence: 1,
    pinned: false,
    needsReview: false,
    tombstoned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: `2026-09-${String(1 + (n % 27)).padStart(2, "0")}T00:00:00.000Z`,
    versions: 1,
    summary: `memory ${n}`,
    content: `memory ${n} body`,
    ...over,
  };
}

/** Behaviour every MemoryIndex must satisfy (ADR-005). */
export function runIndexConformance(name: string, create: () => Promise<MemoryIndex>): void {
  describe(`MemoryIndex conformance: ${name}`, () => {
    it("starts empty, reports capabilities and revisions", async () => {
      const ix = await create();
      expect(await ix.count()).toBe(0);
      expect(ix.capabilities().lexical).toBe(true);
      expect(await ix.revisions()).toEqual({});
      await ix.setRevisions({ "personal/user/test/semantic/2026-09": "abc" });
      expect(await ix.revisions()).toEqual({ "personal/user/test/semantic/2026-09": "abc" });
      await ix.close();
    });

    it("upserts, gets back the same projection, and replaces on re-upsert", async () => {
      const ix = await create();
      const a = doc({ tags: ["x"], dataKeys: ["role"] });
      await ix.upsert([a]);
      expect((await ix.get([a.memoryId])).get(a.memoryId)).toEqual(a);
      await ix.upsert([{ ...a, summary: "changed", pinned: true }]);
      expect(await ix.count()).toBe(1);
      expect((await ix.get([a.memoryId])).get(a.memoryId)?.summary).toBe("changed");
      await ix.close();
    });

    it("ranks lexical matches first and normalises relevance to 0..1", async () => {
      const ix = await create();
      const hit = doc({ content: "notes anchor to the root commit of the repository" });
      const near = doc({ content: "the root of the problem" });
      const miss = doc({ content: "unrelated sqlite indexing" });
      await ix.upsert([hit, near, miss]);
      const hits = await ix.search({ text: "root commit anchor", limit: 10 });
      expect(hits[0]?.memoryId).toBe(hit.memoryId);
      expect(hits[0]?.relevance).toBe(1);
      expect(hits.map((h) => h.memoryId)).not.toContain(miss.memoryId);
      for (const h of hits) expect(h.relevance).toBeLessThanOrEqual(1);
      await ix.close();
    });

    it("filters by type, level, namespace prefix, subject, tags, excluded tags, data key, time and pinned", async () => {
      const ix = await create();
      const a = doc({
        type: "procedural",
        namespace: "org/eyelock/x",
        subject: "topic:ci",
        tags: ["ci", "git"],
        dataKeys: ["cmd"],
        pinned: true,
        updatedAt: "2026-09-20T00:00:00.000Z",
      });
      const b = doc({
        type: "episodic",
        level: "distributed",
        namespace: "org/eyelockx",
        tags: ["ci"],
        updatedAt: "2026-09-10T00:00:00.000Z",
      });
      await ix.upsert([a, b]);
      const ids = async (q: Parameters<MemoryIndex["search"]>[0]) =>
        (await ix.search(q)).map((h) => h.memoryId);
      expect(await ids({ type: ["procedural"], limit: 10 })).toEqual([a.memoryId]);
      expect(await ids({ level: ["distributed"], limit: 10 })).toEqual([b.memoryId]);
      expect(await ids({ namespace: "org/eyelock", limit: 10 })).toEqual([a.memoryId]);
      expect(await ids({ subject: "topic:ci", limit: 10 })).toEqual([a.memoryId]);
      expect((await ids({ tags: ["ci"], limit: 10 })).sort()).toEqual(
        [a.memoryId, b.memoryId].sort()
      );
      expect(await ids({ tags: ["ci", "git"], limit: 10 })).toEqual([a.memoryId]);
      expect(await ids({ excludeTags: ["git"], limit: 10 })).toEqual([b.memoryId]);
      expect(await ids({ tags: ["ci"], excludeTags: ["x", "git"], limit: 10 })).toEqual([
        b.memoryId,
      ]);
      expect(await ids({ dataKey: "cmd", limit: 10 })).toEqual([a.memoryId]);
      expect(await ids({ since: "2026-09-15T00:00:00.000Z", limit: 10 })).toEqual([a.memoryId]);
      expect(await ids({ until: "2026-09-15T00:00:00.000Z", limit: 10 })).toEqual([b.memoryId]);
      expect(await ids({ pinnedOnly: true, limit: 10 })).toEqual([a.memoryId]);
      await ix.close();
    });

    it("hides tombstoned memories unless asked", async () => {
      const ix = await create();
      const t = doc({ tombstoned: true, content: "gone root" });
      await ix.upsert([t]);
      expect(await ix.search({ text: "root", limit: 10 })).toEqual([]);
      expect(
        (await ix.search({ text: "root", includeTombstoned: true, limit: 10 })).map(
          (h) => h.memoryId
        )
      ).toEqual([t.memoryId]);
      await ix.close();
    });

    it("removes, rebuilds and respects the limit", async () => {
      const ix = await create();
      const docs = Array.from({ length: 20 }, () => doc({ content: "batch item" }));
      await ix.upsert(docs);
      expect((await ix.search({ text: "batch", limit: 5 })).length).toBe(5);
      await ix.remove([docs[0]?.memoryId as string]);
      expect(await ix.count()).toBe(19);
      await ix.rebuild([docs[1] as IndexedMemory], { s: "r1" });
      expect(await ix.count()).toBe(1);
      expect(await ix.revisions()).toEqual({ s: "r1" });
      await ix.close();
    });
  });
}
