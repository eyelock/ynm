import { MemoryRecordSchema } from "@ynm/model";
import { generateCorpus } from "./generator.js";

describe("synthetic corpus generator (ADR-014)", () => {
  it("is deterministic for a seed and produces valid records", () => {
    const a = generateCorpus({ seed: 7, count: 200 });
    const b = generateCorpus({ seed: 7, count: 200 });
    expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
    expect(a.records).toHaveLength(200);
    for (const r of a.records) expect(MemoryRecordSchema.safeParse(r).success).toBe(true);
    expect(a.duplicates.length).toBeGreaterThan(0);
    expect(a.queries.length).toBeGreaterThan(0);
  });
  it("differs across seeds", () => {
    expect(generateCorpus({ seed: 1, count: 10 }).records[0]?.id).not.toBe(
      generateCorpus({ seed: 2, count: 10 }).records[0]?.id
    );
  });
});
