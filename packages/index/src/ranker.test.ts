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
