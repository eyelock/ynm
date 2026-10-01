import type { MemoryRecord } from "@ynm/model";
import { memoryFromBase } from "@ynm/store";
import { toIndexed } from "./types.js";

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    v: 1,
    id: "01M00000000000000000000001",
    memoryId: "01M00000000000000000000001",
    op: "create",
    type: "semantic",
    level: "personal",
    namespace: "user/test",
    subject: "build",
    tags: ["ci"],
    links: [],
    content: "Run make verify before pushing.",
    summary: "make verify first",
    importance: 0.7,
    recordedAt: "2026-09-01T00:00:00.000Z",
    provenance: { actor: "test" },
    ...over,
  };
}

describe("toIndexed", () => {
  it("copies memory state and keeps the folded memory as state", () => {
    const m = memoryFromBase(record());
    const ix = toIndexed("personal", m);
    expect(ix).toMatchObject({
      memoryId: m.memoryId,
      mount: "personal",
      type: "semantic",
      level: "personal",
      namespace: "user/test",
      subject: "build",
      tags: ["ci"],
      dataKeys: [],
      importance: 0.7,
      confidence: 1,
      pinned: false,
      tombstoned: false,
      versions: 1,
      summary: "make verify first",
      content: "Run make verify before pushing.",
    });
    expect(ix.state).toBe(m);
  });

  it("indexes data keys and appends string data values to the content", () => {
    const m = memoryFromBase(
      record({ data: { command: "make verify", retries: 3, owner: "david", nested: { a: "b" } } })
    );
    const ix = toIndexed("team", m);
    expect(ix.dataKeys).toEqual(["command", "retries", "owner", "nested"]);
    expect(ix.content).toBe("Run make verify before pushing.\nmake verify david");
  });

  it("uses empty strings when the record has no summary or content", () => {
    const m = memoryFromBase(record({ summary: undefined, content: undefined, data: { k: "v" } }));
    const ix = toIndexed("personal", m);
    expect(ix.summary).toBe("");
    expect(ix.content).toBe("\nv");
  });

  it("adds no separator when data holds no strings", () => {
    const m = memoryFromBase(record({ data: { n: 1 } }));
    expect(toIndexed("personal", m).content).toBe("Run make verify before pushing.");
  });
});
