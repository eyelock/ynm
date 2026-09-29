import {
  LOCOMO_CATEGORIES,
  parseLocomoDate,
  parseLongMemEvalDate,
  sampleCases,
} from "./datasets.js";

describe("tier3 dataset adapters", () => {
  it("parses both benchmarks' date formats to ISO", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseLocomoDate("12:05 am on 21 January 2024")).toBe("2024-01-21T00:05:00.000Z");
    expect(parseLongMemEvalDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(() => parseLocomoDate("yesterday")).toThrow(/unparseable/);
  });
  it("samples deterministically", () => {
    const cases = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      sessions: [],
      questions: [],
    }));
    const a = sampleCases(cases, 5, 7).map((c) => c.id);
    const b = sampleCases(cases, 5, 7).map((c) => c.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(5);
    expect(sampleCases(cases, 50)).toHaveLength(20);
    expect(LOCOMO_CATEGORIES[5]).toBe("adversarial");
  });
});
