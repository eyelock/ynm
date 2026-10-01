import { buildContext } from "./context.js";
import { fuse, rank, recencyScore } from "./ranker.js";
import { doc } from "./testing/conformance.js";

describe("ranker (ADR-005)", () => {
  const now = new Date("2026-09-29T00:00:00.000Z");
  it("decays by half-life per type and never for procedural", () => {
    expect(recencyScore("episodic", "2026-09-15T00:00:00.000Z", now)).toBeCloseTo(0.5, 2);
    expect(recencyScore("procedural", "2020-01-01T00:00:00.000Z", now)).toBe(1);
  });
  it("blends relevance, recency, importance and pin, and explains", () => {
    const fresh = doc({ updatedAt: "2026-09-28T00:00:00.000Z", type: "episodic", importance: 0.2 });
    const important = doc({
      updatedAt: "2026-06-01T00:00:00.000Z",
      type: "episodic",
      importance: 0.9,
    });
    const pinned = doc({
      updatedAt: "2026-06-01T00:00:00.000Z",
      type: "episodic",
      importance: 0.2,
      pinned: true,
    });
    const byId = new Map([fresh, important, pinned].map((m) => [m.memoryId, m]));
    const hits = [fresh, important, pinned].map((m) => ({
      memoryId: m.memoryId,
      relevance: 1,
      source: "t",
    }));
    const ranked = rank([hits], byId, { hasText: true, now, explain: true });
    expect(ranked[0]?.memoryId).toBe(fresh.memoryId);
    expect(ranked[0]?.explain?.recency).toBeGreaterThan(0.9);
    expect(ranked.find((r) => r.memoryId === pinned.memoryId)?.explain?.pinned).toBe(1);
    const filterOnly = rank([hits], byId, { hasText: false, now });
    expect(filterOnly[0]?.memoryId).toBe(fresh.memoryId);
  });
  it("fuses several hit lists with reciprocal rank", () => {
    const f = fuse([
      [
        { memoryId: "a", relevance: 1, source: "x" },
        { memoryId: "b", relevance: 0.5, source: "x" },
      ],
      [{ memoryId: "b", relevance: 1, source: "y" }],
    ]);
    expect((f.get("b") ?? 0) > (f.get("a") ?? 0)).toBe(true);
  });
  it("packs a context block to a token budget, pinned first", () => {
    const p = doc({ pinned: true, summary: "pinned rule" });
    const r1 = doc({ summary: "ranked one" });
    const r2 = doc({ summary: "ranked two" });
    const byId = new Map([p, r1, r2].map((m) => [m.memoryId, m]));
    const block = buildContext(
      [p],
      [
        { memoryId: r1.memoryId, score: 1 },
        { memoryId: r2.memoryId, score: 0.5 },
      ],
      byId,
      20
    );
    expect(block.markdown.startsWith("## Memory\n- (semantic, pinned) pinned rule")).toBe(true);
    expect(block.truncated).toBe(true);
    expect(block.included).toEqual([p.memoryId, r1.memoryId]);
  });
});

describe("rank edge cases", () => {
  const now = new Date("2026-09-29T00:00:00.000Z");
  const flat = { relevance: 1, recency: 0, importance: 0, pinned: 0 };

  it("keeps the best relevance when one list repeats a memory", () => {
    const m = doc();
    const ranked = rank(
      [
        [
          { memoryId: m.memoryId, relevance: 0.3, source: "a" },
          { memoryId: m.memoryId, relevance: 0.8, source: "a" },
          { memoryId: m.memoryId, relevance: 0.5, source: "a" },
        ],
      ],
      new Map([[m.memoryId, m]]),
      { hasText: true, now, weights: flat }
    );
    expect(ranked).toEqual([{ memoryId: m.memoryId, score: 0.8, explain: undefined }]);
  });

  it("normalises fused relevance so the top fused hit scores 1", () => {
    const a = doc();
    const b = doc();
    const byId = new Map([a, b].map((m) => [m.memoryId, m]));
    const ranked = rank(
      [
        [
          { memoryId: a.memoryId, relevance: 1, source: "x" },
          { memoryId: b.memoryId, relevance: 1, source: "x" },
        ],
        [{ memoryId: b.memoryId, relevance: 1, source: "y" }],
      ],
      byId,
      { hasText: true, now, weights: flat, explain: true }
    );
    expect(ranked.map((r) => r.memoryId)).toEqual([b.memoryId, a.memoryId]);
    expect(ranked[0]?.explain?.relevance).toBe(1);
    expect(ranked[1]?.explain?.relevance).toBeGreaterThan(0);
    expect(ranked[1]?.explain?.relevance).toBeLessThan(1);
  });

  it("returns nothing for no lists and drops hits whose memory is unknown", () => {
    const m = doc();
    const byId = new Map([[m.memoryId, m]]);
    expect(rank([], byId, { hasText: false, now })).toEqual([]);
    expect(
      rank([[{ memoryId: "missing", relevance: 1, source: "x" }]], byId, { hasText: true, now })
    ).toEqual([]);
  });

  it("breaks score ties by memory id, descending", () => {
    const a = doc({ memoryId: "01A", type: "procedural" });
    const b = doc({ memoryId: "01B", type: "procedural" });
    const byId = new Map([a, b].map((m) => [m.memoryId, m]));
    const hits = [a, b].map((m) => ({ memoryId: m.memoryId, relevance: 1, source: "x" }));
    expect(rank([hits], byId, { hasText: true, now }).map((r) => r.memoryId)).toEqual([
      "01B",
      "01A",
    ]);
  });

  it("treats a future updatedAt as age zero", () => {
    expect(recencyScore("working", "2027-01-01T00:00:00.000Z", now)).toBe(1);
  });
});
