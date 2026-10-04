import { DreamConfigSchema } from "@ynm/model";
import { type Judge, type Judgment, NoneWriter, type Question } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { IndexManager } from "./indexing.js";
import { Ynm } from "./ynm.js";

function make(): Ynm {
  let t = 0;
  return new Ynm({
    mounts: [
      {
        id: "personal",
        level: "personal",
        location: "mem",
        log: new MemoryLog("personal", "personal"),
      },
      {
        id: "project",
        level: "distributed",
        location: "mem",
        log: new MemoryLog("project", "distributed"),
      },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
    now: () => new Date(Date.parse("2026-09-29T00:00:00.000Z") + ++t * 60_000),
  });
}

describe("recall and context (ADR-005)", () => {
  it("recalls across mounts, ranked, with explain", async () => {
    const y = make();
    await y.remember({
      type: "semantic",
      content: "Notes anchor to the root commit",
      tags: ["git"],
    });
    await y.remember({
      type: "procedural",
      level: "distributed",
      content: "Run pnpm check before pushing",
    });
    await y.remember({ type: "reference", content: "SQLite FTS5 docs at sqlite.org" });
    const hits = await y.recall({ text: "root commit anchor", explain: true });
    expect(hits[0]?.content).toMatch(/root commit/);
    expect(hits[0]?.mount).toBe("personal");
    expect(hits[0]?.explain?.weights.relevance).toBeGreaterThan(0);
    const distributed = await y.recall({ level: ["distributed"] });
    expect(distributed.map((h) => h.mount)).toEqual(["project"]);
  });

  it("updates the index exactly after supersede, annotate and forget without a rebuild", async () => {
    const y = make();
    const { memoryId } = await y.remember({
      type: "semantic",
      content: "version one about anchors",
    });
    await y.supersede({ memoryId, content: "version two about anchors and shards" });
    let [hit] = await y.recall({ text: "shards" });
    expect(hit?.memoryId).toBe(memoryId);
    expect(hit?.content).toMatch(/version two/);
    await y.pin(memoryId);
    [hit] = await y.recall({ pinnedOnly: true });
    expect(hit?.memoryId).toBe(memoryId);
    await y.forget({ memoryId });
    expect(await y.recall({ text: "anchors" })).toEqual([]);
    expect((await y.indexStatus()).every((f) => f.fresh)).toBe(true);
  });

  it("rebuilds when the log changed behind the index", async () => {
    const y = make();
    await y.remember({ type: "semantic", content: "first" });
    expect((await y.recall({ text: "first" })).length).toBe(1);
    // Another writer appends directly to the log.
    const mount = y.mount("personal");
    const [r] = await y.records({ includeTombstoned: false });
    await mount.log.append(
      [
        {
          ...(r as NonNullable<typeof r>),
          id: "01M00000000000000000000001",
          memoryId: "01M00000000000000000000001",
          content: "second sneaky",
        },
      ].map(({ mount: _m, ...x }) => x)
    );
    expect((await y.indexStatus()).find((f) => f.mount === "personal")?.fresh).toBe(false);
    expect((await y.recall({ text: "sneaky" })).length).toBe(1);
    expect((await y.indexStatus()).find((f) => f.mount === "personal")?.fresh).toBe(true);
  });

  it("finds structured data by value and filters by key", async () => {
    const y = make();
    await y.remember({
      type: "semantic",
      content: "profile",
      data: { role: "platform engineer", team: "core" },
      dataSchema: "user-profile/1",
    });
    await y.remember({ type: "semantic", content: "no data here" });
    expect((await y.recall({ text: "platform engineer" }))[0]?.content).toBe(
      "profile\nplatform engineer core"
    );
    expect((await y.recall({ dataKey: "team" })).length).toBe(1);
  });

  it("builds a context block with pinned first inside the budget", async () => {
    const y = make();
    const { memoryId } = await y.remember({
      type: "procedural",
      content: "Always run the gate",
      summary: "Always run the gate",
    });
    await y.pin(memoryId);
    for (let i = 0; i < 20; i++)
      await y.remember({
        type: "episodic",
        content: `Event ${i} about releases`,
        summary: `Event ${i}`,
      });
    const block = await y.context({ budgetTokens: 60 });
    expect(block.markdown.split("\n")[1]).toMatch(/pinned\) Always run the gate/);
    expect(block.truncated).toBe(true);
    expect(block.tokens).toBeLessThanOrEqual(60);
    const focused = await y.context({ text: "releases", budgetTokens: 400 });
    expect(focused.included.length).toBeGreaterThan(5);
  });

  it("reindex reproduces identical hits", async () => {
    const y = make();
    for (let i = 0; i < 30; i++)
      await y.remember({
        type: "semantic",
        content: `memory ${i} about ${i % 3 ? "git" : "sqlite"}`,
      });
    const before = (await y.recall({ text: "sqlite", limit: 20 })).map((h) => h.memoryId);
    const counts = await y.reindex();
    expect(counts.personal).toBe(30);
    expect((await y.recall({ text: "sqlite", limit: 20 })).map((h) => h.memoryId)).toEqual(before);
  });
});

/** Scores each memory by whether its content contains `favour`; throws for content with `boom`. */
function relevanceJudge(favour: string): Judge {
  return {
    name: "relevance",
    calibrated: true,
    limits: () => ({ stateTokens: 1e6, requestTokens: 1e6, maxChoices: 255 }),
    async judge<Q extends Record<string, Question>>(state: unknown, questions: Q) {
      const s = state as { memory?: { content?: string } };
      const content = s.memory?.content ?? "";
      if (content.includes("boom")) throw new Error("judge failed on this memory");
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions))
        answers[id] =
          id === "importance"
            ? { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.1 }
            : { type: "noul", noul: id === "sensitive" ? 0 : content.includes(favour) ? 1 : 0 };
      return {
        answers,
        model: "relevance",
        calibrated: true,
        usage: { inputTokens: 1, outputTokens: 0 },
      } as Judgment<Q>;
    },
  };
}

function withRerank(judge: Judge, dream: Record<string, unknown> = {}): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      {
        id: "project",
        level: "distributed",
        location: "mem",
        log: new MemoryLog("q", "distributed"),
      },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
    models: { judge, writer: new NoneWriter(), resolution: { judge: "t", writer: "t" } },
    dream: DreamConfigSchema.parse(dream),
  });
}

describe("judge-backed rerank", () => {
  async function seed(y: Ynm): Promise<{ lexical: string; judged: string }> {
    const lexical = await y.remember({
      type: "semantic",
      content: "deploy deploy deploy checklist deploy",
    });
    const judged = await y.remember({ type: "semantic", content: "deploy uses the blue cluster" });
    await y.remember({ type: "semantic", content: "deploy boom notes" });
    return { lexical: lexical.memoryId, judged: judged.memoryId };
  }

  it("puts the memory the judge finds relevant first and blends the score into explain", async () => {
    const y = withRerank(relevanceJudge("blue cluster"));
    const { judged } = await seed(y);
    const hits = await y.recall({ text: "deploy", explain: true });
    expect(hits[0]?.memoryId).toBe(judged);
    expect(hits[0]?.explain?.relevance).toBe(1);
    expect(hits[0]?.explain?.total).toBeCloseTo(hits[0]?.score ?? 0);
    expect(hits).toHaveLength(3);
    const plain = await y.recall({ text: "deploy" });
    expect(plain[0]?.explain).toBeUndefined();
    expect(plain[0]?.memoryId).toBe(judged);
  });

  it("is skipped when disabled per query, in config, or when there is no text", async () => {
    const off = withRerank(relevanceJudge("blue cluster"), { rerank: false });
    const ids = await seed(off);
    const y = withRerank(relevanceJudge("blue cluster"));
    await seed(y);
    expect((await y.recall({ text: "deploy" }))[0]?.content).toBe("deploy uses the blue cluster");
    for (const hits of [
      await off.recall({ text: "deploy" }),
      await y.recall({ text: "deploy", rerank: false }),
    ]) {
      expect(hits[0]?.content).toBe("deploy deploy deploy checklist deploy");
      expect(hits.map((h) => h.content)).toContain("deploy uses the blue cluster");
    }
    expect((await off.recall({ text: "deploy" }))[0]?.memoryId).toBe(ids.lexical);
    expect((await y.recall({ limit: 1 })).length).toBe(1);
  });
});

describe("context and index maintenance", () => {
  it("orders several pinned memories by importance, then recency", async () => {
    const y = make();
    const low = await y.remember({ type: "semantic", content: "low pin", importance: 0.2 });
    const old = await y.remember({ type: "semantic", content: "old high pin", importance: 0.9 });
    const recent = await y.remember({ type: "semantic", content: "new high pin", importance: 0.9 });
    for (const m of [low, old, recent]) await y.pin(m.memoryId);
    const block = await y.context({ budgetTokens: 400 });
    const order = ["new high pin", "old high pin", "low pin"].map((t) => block.markdown.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await y.pin(low.memoryId, false);
    const unpinned = await y.find(low.memoryId);
    expect(unpinned?.pinned).toBe(false);
    expect(unpinned?.current.reason ?? "").toBe("");
  });

  it("reindexes only the named mount", async () => {
    const y = make();
    await y.remember({ type: "semantic", content: "personal one" });
    await y.remember({ type: "semantic", level: "distributed", content: "project one" });
    expect(await y.reindex("project")).toEqual({ project: 1 });
  });
});
