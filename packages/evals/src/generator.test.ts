import { MemoryRecordSchema } from "@ynm/model";
import { generateCorpus } from "./generator.js";

describe("synthetic corpus generator (ADR-014)", () => {
  it("is deterministic for a seed and produces valid records", () => {
    const a = generateCorpus({ seed: 7, count: 400, duplicateRate: 0.08, contradictionRate: 0.04 });
    const b = generateCorpus({ seed: 7, count: 400, duplicateRate: 0.08, contradictionRate: 0.04 });
    expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
    expect(a.records).toHaveLength(400);
    for (const r of a.records) expect(MemoryRecordSchema.safeParse(r).success).toBe(true);
    expect(a.duplicates.length).toBeGreaterThan(0);
    expect(a.contradictions.length).toBeGreaterThan(0);
    expect(a.queries.length).toBeGreaterThan(0);
    const byId = new Map(a.records.map((r) => [r.memoryId, r]));
    for (const [x, y] of a.duplicates) expect(byId.get(x)?.subject).toBe(byId.get(y)?.subject);
    for (const [x, y] of a.contradictions)
      expect(byId.get(x)?.content).not.toBe(byId.get(y)?.content);
  });
  it("differs across seeds", () => {
    expect(generateCorpus({ seed: 1, count: 10 }).records[0]?.id).not.toBe(
      generateCorpus({ seed: 2, count: 10 }).records[0]?.id
    );
  });
});
