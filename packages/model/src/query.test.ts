import { ContextQuerySchema, RecallQuerySchema } from "./query.js";

describe("query schemas (ADR-005)", () => {
  it("defaults limit, explain and tombstone handling", () => {
    const q = RecallQuerySchema.parse({ text: "root commit" });
    expect(q.limit).toBe(10);
    expect(q.explain).toBe(false);
    expect(q.includeTombstoned).toBe(false);
  });
  it("accepts a bare date for since and until as midnight UTC", () => {
    const q = RecallQuerySchema.parse({ since: "2026-09-01", until: "2026-09-30T12:00:00Z" });
    expect(q.since).toBe("2026-09-01T00:00:00.000Z");
    expect(q.until).toBe("2026-09-30T12:00:00Z");
  });
  it("words a bad date as an ISO 8601 date-time expectation", () => {
    const r = RecallQuerySchema.safeParse({ since: "last tuesday" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("expected an ISO 8601 date-time");
  });
  it("caps the limit and rejects unknown keys", () => {
    expect(RecallQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(RecallQuerySchema.safeParse({ foo: 1 }).success).toBe(false);
  });
  it("context defaults to a 1500 token budget", () => {
    expect(ContextQuerySchema.parse({}).budgetTokens).toBe(1500);
  });
});
