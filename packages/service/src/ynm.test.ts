import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamConfigSchema } from "@ynm/model";
import { type Judge, type Judgment, NoneWriter, type Question } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "./config.js";
import { RedactionError } from "./redaction.js";
import { ShareRequiredError, Ynm } from "./ynm.js";

function make(withProject = true): Ynm {
  const mounts = [
    {
      id: "personal",
      level: "personal" as const,
      location: "mem",
      log: new MemoryLog("personal", "personal"),
    },
  ];
  if (withProject)
    mounts.push({
      id: "project",
      level: "distributed" as const,
      location: "mem",
      log: new MemoryLog("project", "distributed"),
    });
  return new Ynm({ mounts, actor: "test", userId: "david", redaction: DEFAULT_REDACTION });
}

describe("Ynm service", () => {
  it("remembers into the personal mount with user namespace by default", async () => {
    const y = make();
    const r = await y.remember({ type: "semantic", content: "# Anchor\nRoot commit." });
    expect(r.mount).toBe("personal");
    const [m] = await y.list();
    expect(m?.namespace).toBe("user/david");
    expect(m?.current.summary).toBe("Anchor");
    expect(m?.current.provenance.actor).toBe("test");
  });

  it("never shares by default: with no personal mount, a memory needs an explicit distributed level", async () => {
    const y = new Ynm({
      mounts: [
        {
          id: "project",
          level: "distributed",
          location: "mem",
          log: new MemoryLog("project", "distributed"),
        },
      ],
      actor: "test",
      userId: "david",
      redaction: DEFAULT_REDACTION,
    });
    expect(y.defaultLevel()).toBe("distributed");
    await expect(y.remember({ type: "semantic", content: "Call the user DC." })).rejects.toThrow(
      ShareRequiredError
    );
    expect(await y.list()).toEqual([]);
    const r = await y.remember({
      type: "semantic",
      level: "distributed",
      content: "Call the user DC.",
    });
    expect(r.mount).toBe("project");
    const [m] = await y.list();
    expect(m?.current.level).toBe("distributed");
    expect(m?.namespace).toBe("common");
    // An explicit personal level still fails: the default never overrides what was asked for.
    await expect(y.remember({ type: "semantic", level: "personal", content: "x" })).rejects.toThrow(
      /no personal mount available/
    );
  });

  it("keeps personal as the default when a personal mount is open", () => {
    expect(make().defaultLevel()).toBe("personal");
    expect(make(false).defaultLevel()).toBe("personal");
  });

  it("routes distributed records to the project mount", async () => {
    const y = make();
    const r = await y.remember({
      type: "procedural",
      level: "distributed",
      content: "Run pnpm check before push.",
    });
    expect(r.mount).toBe("project");
    expect((await y.list({ level: "distributed", includeTombstoned: false }))[0]?.namespace).toBe(
      "common"
    );
  });

  it("fails clearly when no distributed mount exists", async () => {
    await expect(
      make(false).remember({ type: "semantic", level: "distributed", content: "x" })
    ).rejects.toThrow(/ynm init/);
  });

  it("supersede, annotate and forget fold as expected", async () => {
    const y = make();
    const { memoryId } = await y.remember({ type: "semantic", content: "v1", tags: ["a"] });
    await y.supersede({ memoryId, content: "v2", tags: ["b"] });
    await y.annotate({ memoryId, pinned: true, importance: 0.9 });
    let [m] = await y.list();
    expect(m?.current.content).toBe("v2");
    expect(m?.tags).toEqual(["a", "b"]);
    expect(m?.pinned).toBe(true);
    expect(m?.importance).toBe(0.9);
    expect(m?.versions).toBe(3);
    await y.forget({ memoryId, reason: "obsolete" });
    expect(await y.list()).toHaveLength(0);
    [m] = await y.list({ includeTombstoned: true });
    expect(m?.tombstoned).toBe(true);
  });

  it("refuses distributed writes that contain secrets (ADR-007)", async () => {
    const y = make();
    await expect(
      y.remember({
        type: "semantic",
        level: "distributed",
        content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
      })
    ).rejects.toThrow(/redaction/);
    await expect(
      y.remember({ type: "semantic", content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" })
    ).resolves.toBeTruthy();
  });

  it("promotes a personal memory as a new distributed record linked derives-from", async () => {
    const y = make();
    const { memoryId } = await y.remember({ type: "procedural", content: "Always run the gate." });
    const p = await y.promote(memoryId);
    expect(p.mount).toBe("project");
    const distributed = (await y.list({ level: "distributed", includeTombstoned: false }))[0];
    expect(distributed?.namespace).toBe("common");
    expect(distributed?.links).toEqual([{ rel: "derives-from", to: memoryId }]);
    expect((await y.list({ level: "personal", includeTombstoned: false }))[0]?.memoryId).toBe(
      memoryId
    );
    await expect(y.promote(p.memoryId)).rejects.toThrow(/already distributed/);
  });

  it("exports and imports JSONL, routing by level and reporting bad lines", async () => {
    const y = make();
    await y.remember({ type: "semantic", content: "one" });
    await y.remember({ type: "semantic", level: "distributed", content: "two" });
    const text = await y.exportJsonl();
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    const z = make();
    const res = await z.importJsonl(`${text}garbage\n`);
    expect(res.imported).toBe(2);
    expect(res.problems).toHaveLength(1);
    expect(await z.list()).toHaveLength(2);
  });

  it("lists newest first with filters and limit", async () => {
    let t = 0;
    const y = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: [],
      now: () => new Date(1_800_000_000_000 + ++t * 1000),
    });
    await y.remember({ type: "semantic", content: "a" });
    await y.remember({ type: "episodic", content: "b" });
    await y.remember({ type: "semantic", content: "c" });
    expect((await y.list()).map((m) => m.current.content)).toEqual(["c", "b", "a"]);
    expect(
      (await y.list({ type: "semantic", includeTombstoned: false, limit: 1 })).map(
        (m) => m.current.content
      )
    ).toEqual(["c"]);
  });

  it("sync only touches distributed mounts unless one is named", async () => {
    const y = make();
    expect(await y.sync()).toEqual({});
    expect((await y.status()).mounts.map((m) => m.id)).toEqual(["personal", "project"]);
  });

  it("reports the temp dir helper works for later tests", () => {
    expect(mkdtempSync(join(tmpdir(), "ynm-svc-"))).toBeTruthy();
  });
});

/** A judge that answers every question from a fixed table, or throws when asked to. */
function tableJudge(
  answers: Record<string, unknown>,
  opts: { calibrated?: boolean; fail?: boolean } = {}
): Judge {
  return {
    name: "table",
    calibrated: opts.calibrated ?? true,
    limits: () => ({ stateTokens: 1e6, requestTokens: 1e6, maxChoices: 255 }),
    async judge<Q extends Record<string, Question>>(_state: unknown, questions: Q) {
      if (opts.fail) throw new Error("judge offline");
      const out: Record<string, unknown> = {};
      for (const id of Object.keys(questions)) out[id] = answers[id];
      return {
        answers: out,
        model: "table",
        calibrated: opts.calibrated ?? true,
        usage: { inputTokens: 1, outputTokens: 0 },
      } as Judgment<Q>;
    },
  };
}

function withJudge(judge: Judge, dream: Record<string, unknown> = {}): Ynm {
  return new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "test",
    userId: "david",
    redaction: DEFAULT_REDACTION,
    models: { judge, writer: new NoneWriter(), resolution: { judge: "t", writer: "t" } },
    dream: DreamConfigSchema.parse(dream),
  });
}

describe("Ynm routing and lookup errors", () => {
  it("names the mounts it has when asked for one it does not", () => {
    expect(() => make().mount("org")).toThrow(/no mount "org" \(have: personal, project\)/);
    const empty = new Ynm({ mounts: [], actor: "t", userId: "u", redaction: [] });
    expect(() => empty.mount("org")).toThrow(/have: none/);
    expect(() => empty.routeFor("personal")).toThrow(/no personal mount available/);
  });

  it("refuses a named mount whose level does not match the record", async () => {
    await expect(
      make().remember({ type: "semantic", level: "distributed", content: "x" }, "personal")
    ).rejects.toThrow(/mount "personal" is personal; cannot take a distributed record/);
  });

  it("routes distributed writes to any distributed mount when there is no project", async () => {
    const y = new Ynm({
      mounts: [
        { id: "org", level: "distributed", location: "m", log: new MemoryLog("o", "distributed") },
      ],
      actor: "t",
      userId: "u",
      redaction: [],
    });
    const r = await y.remember({ type: "semantic", level: "distributed", content: "org fact" });
    expect(r.mount).toBe("org");
    expect(y.defaultNamespace("distributed")).toBe("common");
    expect(y.defaultNamespace("personal")).toBe("user/u");
  });

  it("fails clearly for unknown memories and for recall without an index", async () => {
    const y = make();
    await expect(y.forget({ memoryId: "01M0000000000000000000ZZZZ" })).rejects.toThrow(
      /unknown memory/
    );
    await expect(y.recall({ text: "x" })).rejects.toThrow(/no index configured/);
    await expect(y.context({})).rejects.toThrow(/no index configured/);
    await expect(y.reindex()).rejects.toThrow(/no index configured/);
    expect(await y.indexStatus()).toEqual([]);
    expect(Ynm.logOf(y.mount("personal")).provider).toBe("memory");
  });

  it("refuses to promote a memory that is already distributed", async () => {
    const y = make();
    const { memoryId } = await y.remember({ type: "semantic", level: "distributed", content: "x" });
    await expect(y.promote(memoryId)).rejects.toThrow(/already distributed/);
  });

  it("keeps a non-user namespace when promoting", async () => {
    const y = make();
    const { memoryId } = await y.remember({
      type: "procedural",
      namespace: "team/build",
      content: "Build with make",
    });
    const promoted = await y.promote(memoryId);
    expect((await y.find(promoted.memoryId))?.namespace).toBe("team/build");
  });
});

describe("Ynm list, records and sync filters", () => {
  it("filters records and memories by mount, level, time and review state", async () => {
    let t = Date.parse("2026-09-01T00:00:00.000Z");
    const y = new Ynm({
      mounts: [
        { id: "personal", level: "personal", location: "m", log: new MemoryLog("p", "personal") },
        {
          id: "project",
          level: "distributed",
          location: "m",
          log: new MemoryLog("q", "distributed"),
        },
      ],
      actor: "t",
      userId: "u",
      redaction: [],
      now: () => {
        t += 86_400_000;
        return new Date(t);
      },
    });
    const a = await y.remember({ type: "semantic", content: "first personal" });
    const b = await y.remember({ type: "semantic", level: "distributed", content: "shared" });
    const c = await y.remember({ type: "semantic", content: "second personal" });
    await y.annotate({ memoryId: c.memoryId, needsReview: true });
    await y.forget({ memoryId: a.memoryId });

    expect(
      (await y.records({ includeTombstoned: true, mount: "project" })).map((r) => r.id)
    ).toEqual([b.recordId]);
    expect(
      (await y.records({ includeTombstoned: true, level: "personal" })).every(
        (r) => r.mount === "personal"
      )
    ).toBe(true);
    expect(
      (await y.list({ includeTombstoned: false, mount: "project" })).map((m) => m.memoryId)
    ).toEqual([b.memoryId]);
    expect((await y.list({ includeTombstoned: false, level: "distributed" })).length).toBe(1);
    expect((await y.list({ includeTombstoned: true })).length).toBe(3);
    expect((await y.list({ includeTombstoned: false })).length).toBe(2);
    expect(
      (await y.list({ includeTombstoned: false, since: "2026-09-04T00:00:00.000Z" })).map(
        (m) => m.memoryId
      )
    ).toEqual([c.memoryId]);
    expect(
      (await y.list({ includeTombstoned: false, until: "2026-09-02T12:00:00.000Z" })).map(
        (m) => m.memoryId
      )
    ).toEqual([]);
    expect(
      (await y.list({ includeTombstoned: false, needsReview: false })).map((m) => m.memoryId)
    ).toEqual([b.memoryId]);
    expect((await y.reviewQueue()).map((m) => m.memoryId)).toEqual([c.memoryId]);
  });

  it("orders memories with the same timestamp stably", async () => {
    const fixed = new Date("2026-09-01T00:00:00.000Z");
    const y = new Ynm({
      mounts: [
        { id: "a", level: "personal", location: "m", log: new MemoryLog("a", "personal") },
        { id: "b", level: "personal", location: "m", log: new MemoryLog("b", "personal") },
      ],
      actor: "t",
      userId: "u",
      redaction: [],
      now: () => fixed,
    });
    const r = await y.remember({ type: "semantic", content: "same instant" }, "a");
    const [rec] = await y.records({ includeTombstoned: true });
    if (!rec) throw new Error("no record");
    const { mount: _m, ...record } = rec;
    await y.mount("b").log.append([record]);
    const listed = await y.list();
    expect(listed.map((m) => m.mount)).toEqual(["a", "b"]);
    expect(listed.every((m) => m.memoryId === r.memoryId)).toBe(true);
  });

  it("syncs a named mount even when it is personal, and skips mounts that cannot sync", async () => {
    const synced: string[] = [];
    const log = new MemoryLog("p", "personal");
    const syncing = Object.assign(log, {
      sync: async () => {
        synced.push("personal");
        return { fetched: 0, merged: 0, pushed: 0 } as never;
      },
    });
    const y = new Ynm({
      mounts: [{ id: "personal", level: "personal", location: "m", log: syncing }],
      actor: "t",
      userId: "u",
      redaction: [],
    });
    expect(Object.keys(await y.sync())).toEqual([]);
    expect(Object.keys(await y.sync({ mount: "personal" }))).toEqual(["personal"]);
    expect(synced).toEqual(["personal"]);
    expect(await make().sync({ mount: "project" })).toEqual({});
  });
});

describe("Ynm write-path judge", () => {
  const sensitive = (noul: number) => ({ type: "noul", noul });
  const importance = (score: number, confidence: number) => ({
    type: "score",
    score,
    legend: {},
    probabilities: {},
    confidence,
  });

  it("scores importance when the caller left the default and records the judgment", async () => {
    const y = withJudge(tableJudge({ sensitive: sensitive(0.1), importance: importance(4, 0.9) }));
    const { memoryId } = await y.remember({ type: "semantic", content: "Releases need a tag" });
    const m = await y.find(memoryId);
    expect(m?.importance).toBe(1);
    const data = m?.current.data as { judgments?: Array<{ pass: string }> } | undefined;
    expect(data?.judgments?.[0]?.pass).toBe("write");
  });

  it("keeps an explicit importance and ignores a low-confidence score", async () => {
    const y = withJudge(tableJudge({ sensitive: sensitive(0.1), importance: importance(4, 0.2) }));
    const low = await y.remember({ type: "semantic", content: "Low confidence" });
    expect((await y.find(low.memoryId))?.importance).toBe(0.5);
    const explicit = await y.remember({ type: "semantic", content: "Explicit", importance: 0.9 });
    expect((await y.find(explicit.memoryId))?.importance).toBe(0.9);
  });

  it("refuses content the judge flags as sensitive", async () => {
    const y = withJudge(tableJudge({ sensitive: sensitive(0.95), importance: importance(2, 0.9) }));
    await expect(y.remember({ type: "semantic", content: "my bank PIN" })).rejects.toThrow(
      RedactionError
    );
    expect(await y.list()).toEqual([]);
  });

  it("writes without a judgment when the judge fails, is uncalibrated or is switched off", async () => {
    for (const y of [
      withJudge(tableJudge({}, { fail: true })),
      withJudge(tableJudge({}, { calibrated: false })),
      withJudge(tableJudge({ sensitive: sensitive(0.99) }), { judgeOnWrite: false }),
    ]) {
      const { memoryId } = await y.remember({ type: "semantic", content: "plain fact" });
      const m = await y.find(memoryId);
      expect(m?.current.data).toBeUndefined();
      expect(m?.importance).toBe(0.5);
    }
  });
});
