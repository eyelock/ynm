import {
  CONSOLIDATE_PASSES,
  ConsolidateInputSchema,
  PromoteInputSchema,
  SessionEndInputSchema,
  SessionStartInputSchema,
  SyncInputSchema,
} from "./session.js";

describe("SessionStartInputSchema", () => {
  it("fills the budget and working-memory TTL defaults", () => {
    expect(SessionStartInputSchema.parse({})).toEqual({ budgetTokens: 1500, ttl: "PT8H" });
  });
  it("keeps a supplied session id, namespace, budget and TTL", () => {
    const input = { sessionId: "s-1", namespace: "repo/x", budgetTokens: 400, ttl: "P1D" };
    expect(SessionStartInputSchema.parse(input)).toEqual(input);
  });
  it.each([
    [{ sessionId: "" }, "empty session id"],
    [{ sessionId: "x".repeat(101) }, "session id over 100 chars"],
    [{ budgetTokens: 0 }, "non-positive budget"],
    [{ budgetTokens: 1.5 }, "fractional budget"],
    [{ budgetTokens: 50_001 }, "budget over the cap"],
    [{ ttl: "8 hours" }, "TTL that is not an ISO duration"],
    [{ extra: true }, "unknown key"],
  ] as Array<[unknown, string]>)("rejects %o (%s)", (input) => {
    expect(SessionStartInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("SessionEndInputSchema", () => {
  it("requires a session id and expires working memory by default", () => {
    expect(SessionEndInputSchema.parse({ sessionId: "s-1" })).toEqual({
      sessionId: "s-1",
      expire: true,
    });
    expect(SessionEndInputSchema.safeParse({}).success).toBe(false);
    expect(SessionEndInputSchema.parse({ sessionId: "s-1", expire: false }).expire).toBe(false);
  });
});

describe("ConsolidateInputSchema", () => {
  it("runs every pass, for real, by default", () => {
    const parsed = ConsolidateInputSchema.parse({});
    expect(parsed.passes).toEqual([...CONSOLIDATE_PASSES]);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.maxPairs).toBeUndefined();
  });
  it("default pass list is a copy, not the shared constant", () => {
    const a = ConsolidateInputSchema.parse({});
    a.passes.pop();
    expect(ConsolidateInputSchema.parse({}).passes).toHaveLength(CONSOLIDATE_PASSES.length);
  });
  it("accepts a subset of passes and rejects unknown ones", () => {
    expect(ConsolidateInputSchema.parse({ passes: ["expire", "dedupe"] }).passes).toEqual([
      "expire",
      "dedupe",
    ]);
    expect(ConsolidateInputSchema.safeParse({ passes: ["compact"] }).success).toBe(false);
    expect(ConsolidateInputSchema.safeParse({ maxPairs: 0 }).success).toBe(false);
  });
});

describe("SyncInputSchema", () => {
  it("pulls then pushes by default", () => {
    expect(SyncInputSchema.parse({})).toEqual({ push: true, pull: true, dryRun: false });
  });
  it("keeps remote and mount and rejects unknown keys", () => {
    expect(SyncInputSchema.parse({ remote: "origin", mount: "team", push: false })).toMatchObject({
      remote: "origin",
      mount: "team",
      push: false,
      pull: true,
    });
    expect(SyncInputSchema.safeParse({ force: true }).success).toBe(false);
  });
});

describe("PromoteInputSchema", () => {
  it("needs a memory id and takes an optional mount", () => {
    expect(PromoteInputSchema.parse({ memoryId: "m1", mount: "team" })).toEqual({
      memoryId: "m1",
      mount: "team",
    });
    expect(PromoteInputSchema.safeParse({ memoryId: "" }).success).toBe(false);
  });
});
