import { buildContext } from "./context.js";
import { doc } from "./testing/conformance.js";

describe("buildContext", () => {
  it("writes one line per memory with type, pin and tags", () => {
    const tagged = doc({ type: "procedural", summary: "run make verify", tags: ["ci", "make"] });
    const block = buildContext([tagged], [], new Map(), 1000, "Repo");
    expect(block.markdown).toBe("## Repo\n- (procedural) run make verify [ci, make]\n");
    expect(block.included).toEqual([tagged.memoryId]);
    expect(block.truncated).toBe(false);
    expect(block.tokens).toBeGreaterThan(0);
  });

  it("falls back to the first content line, then to nothing, when there is no summary", () => {
    const noSummary = doc({ summary: "", content: "first line\nsecond line" });
    const empty = doc({ summary: "", content: "" });
    const block = buildContext([noSummary, empty], [], new Map(), 1000);
    expect(block.markdown).toBe("## Memory\n- (semantic) first line\n- (semantic) \n");
  });

  it("skips ranked memories already packed as pinned and ids missing from the map", () => {
    const p = doc({ pinned: true, summary: "pinned" });
    const r = doc({ summary: "ranked" });
    const byId = new Map([p, r].map((m) => [m.memoryId, m]));
    const block = buildContext(
      [p],
      [
        { memoryId: p.memoryId, score: 2 },
        { memoryId: "unknown", score: 1.5 },
        { memoryId: r.memoryId, score: 1 },
      ],
      byId,
      1000
    );
    expect(block.included).toEqual([p.memoryId, r.memoryId]);
    expect(block.markdown).toBe("## Memory\n- (semantic, pinned) pinned\n- (semantic) ranked\n");
  });

  it("marks the block truncated when a pinned memory does not fit, yet still packs ranked ones that do", () => {
    const big = doc({ pinned: true, summary: "x".repeat(400) });
    const small = doc({ summary: "small" });
    const block = buildContext(
      [big],
      [{ memoryId: small.memoryId, score: 1 }],
      new Map([[small.memoryId, small]]),
      30
    );
    expect(block.truncated).toBe(true);
    expect(block.included).toEqual([small.memoryId]);
    expect(block.tokens).toBeLessThanOrEqual(30);
  });

  it("returns empty markdown, not a bare heading, when the budget is too small for anything", () => {
    const m = doc({ summary: "a memory" });
    const block = buildContext([m], [], new Map(), 1);
    expect(block).toEqual({ markdown: "", included: [], tokens: 0, truncated: true });
  });

  it("returns empty markdown when there is no memory at all", () => {
    const block = buildContext([], [], new Map(), 1000);
    expect(block).toEqual({ markdown: "", included: [], tokens: 0, truncated: false });
  });
});
