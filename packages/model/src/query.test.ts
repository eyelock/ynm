import { ContextQuerySchema, RecallQuerySchema } from "./query.js";

describe("query schemas (ADR-005)", () => {
  it("defaults limit, explain and tombstone handling", () => {
    const q = RecallQuerySchema.parse({ text: "root commit" });
    expect(q.limit).toBe(10);
    expect(q.explain).toBe(false);
    expect(q.includeTombstoned).toBe(false);
  });
  it("caps the limit and rejects unknown keys", () => {
    expect(RecallQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(RecallQuerySchema.safeParse({ foo: 1 }).success).toBe(false);
  });
  it("context defaults to a 1500 token budget", () => {
    expect(ContextQuerySchema.parse({}).budgetTokens).toBe(1500);
  });
});
