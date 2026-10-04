import { DreamConfigSchema } from "@ynm/model";
import type { Judge, Judgment, Question } from "@ynm/models";
import { HeuristicJudge, NoneWriter, type Writer } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
import { makeRecord } from "@ynm/store/testing";
import { DEFAULT_REDACTION } from "../config.js";
import { IndexManager } from "../indexing.js";
import { Ynm } from "../ynm.js";
import { dream } from "./engine.js";
import { absolutise } from "./passes.js";
import { addUsage, band } from "./types.js";

/** A calibrated stand-in that answers from a script keyed by question id. */
class ScriptJudge implements Judge {
  readonly name = "script";
  readonly calibrated = true;
  constructor(private readonly script: (state: unknown, id: string) => number) {}
  limits() {
    return { stateTokens: 1e6, requestTokens: 1e6, maxChoices: 255 };
  }
  async judge<Q extends Record<string, Question>>(
    state: unknown,
    questions: Q
  ): Promise<Judgment<Q>> {
    const answers = {} as Judgment<Q>["answers"];
    for (const [id, q] of Object.entries(questions)) {
      // The write-path judge asks these on every remember; keep test scripts focused on the pass under test.
      const v = id === "sensitive" ? 0.01 : id === "importance" ? 2 : this.script(state, id);
      if (q.type === "noul") answers[id as keyof Q] = { type: "noul", noul: v };
      else if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        answers[id as keyof Q] = {
          type: "choice",
          choice: keys[Math.round(v) % keys.length] as string,
          probabilities: {},
          confidence: 0.9,
        };
      } else
        answers[id as keyof Q] = {
          type: "score",
          score: Math.round(v),
          legend: {},
          probabilities: {},
          confidence: 0.9,
        };
    }
    return {
      answers,
      model: "script",
      calibrated: true,
      usage: { inputTokens: 100, outputTokens: 0 },
    };
  }
}

function make(judge: Judge, writer: Writer = new NoneWriter()) {
  let t = 0;
  const now = () => new Date(Date.parse("2026-09-29T00:00:00.000Z") + ++t * 1000);
  const ynm = new Ynm({
    mounts: [
      { id: "personal", level: "personal", location: "mem", log: new MemoryLog("p", "personal") },
    ],
    actor: "t",
    userId: "u",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("memory", { fileFor: () => ":memory:" }),
    models: { judge, writer, resolution: { judge: "test", writer: "test" } },
    dream: DreamConfigSchema.parse({}),
    now,
  });
  const config = DreamConfigSchema.parse({});
  return {
    ynm,
    run: (input: Record<string, unknown>) => dream(ynm, input, { judge, writer, config, now }),
  };
}

describe("dream engine (ADR-006, ADR-012)", () => {
  it("dedupe with a calibrated judge merges, stores the judgment and links the survivor", async () => {
    const { ynm, run } = make(
      new ScriptJudge((_s, id) => (id === "sameFact" ? 0.95 : id === "contradicts" ? 0.02 : 2))
    );
    const a = await ynm.remember({
      type: "semantic",
      content: "Notes anchor to the root commit",
      tags: ["git"],
    });
    const b = await ynm.remember({
      type: "semantic",
      content: "Notes are anchored to the root commit of the repo",
    });
    await ynm.remember({ type: "semantic", content: "Unrelated: releases happen on Fridays" });
    const dry = await run({ passes: ["dedupe"], dryRun: true });
    expect(dry.passes.dedupe?.changed).toHaveLength(1);
    expect((await ynm.list()).length).toBe(3);
    const r = await run({ passes: ["dedupe"] });
    expect(r.judge.calibrated).toBe(true);
    expect(r.passes.dedupe?.changed).toEqual([a.memoryId]);
    expect(r.passes.dedupe?.fallback).toBe(true);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
    const left = await ynm.list();
    expect(left.map((m) => m.memoryId).sort()).not.toContain(a.memoryId);
    const survivor = left.find((m) => m.memoryId === b.memoryId);
    expect(survivor?.links).toEqual([{ rel: "derives-from", to: a.memoryId }]);
    expect(survivor?.tags).toContain("git");
    const records = await ynm.records({ includeTombstoned: true });
    const judgment = records.find((x) => x.op === "annotate" && x.memoryId === b.memoryId);
    const stored = judgment?.data as
      | { judgments: Array<{ pass: string; band: string }> }
      | undefined;
    expect(stored?.judgments[0]).toMatchObject({ pass: "dedupe", band: "act" });
  });

  it("an uncalibrated judge only flags for review, never acts", async () => {
    const { ynm, run } = make(new HeuristicJudge());
    await ynm.remember({
      type: "semantic",
      content: "Notes anchor to the root commit of the repository",
    });
    await ynm.remember({
      type: "semantic",
      content: "Notes anchor to the root commit of the repository always",
    });
    const r = await run({ passes: ["dedupe"] });
    expect(r.passes.dedupe?.changed).toEqual([]);
    expect(r.passes.dedupe?.flagged.length).toBeGreaterThan(0);
    expect((await ynm.reviewQueue()).length).toBe(2);
    expect((await ynm.list({ needsReview: true, includeTombstoned: false })).length).toBe(2);
  });

  it("uses the writer to merge text and fails closed on bad output", async () => {
    const good: Writer = {
      name: "fake",
      write: async () => ({
        value: {
          content: "Merged: notes anchor to the root commit.",
          summary: "Merged anchor fact",
        },
        model: "fake",
      }),
    };
    const { ynm, run } = make(
      new ScriptJudge((_s, id) => (id === "sameFact" ? 0.95 : id === "contradicts" ? 0.02 : 2)),
      good
    );
    await ynm.remember({ type: "semantic", content: "Notes anchor to the root commit" });
    const b = await ynm.remember({
      type: "semantic",
      content: "Notes are anchored to the root commit",
    });
    const r = await run({ passes: ["dedupe"] });
    expect(r.passes.dedupe?.fallback).toBe(false);
    expect((await ynm.find(b.memoryId))?.current.content).toMatch(/^Merged/);
    const bad: Writer = {
      name: "bad",
      write: async () => {
        throw new Error("writer output did not match the schema after 2 attempts");
      },
    };
    const second = make(
      new ScriptJudge((_s, id) => (id === "sameFact" ? 0.95 : id === "contradicts" ? 0.02 : 2)),
      bad
    );
    await second.ynm.remember({ type: "semantic", content: "Alpha beta gamma" });
    await second.ynm.remember({ type: "semantic", content: "Alpha beta gamma delta" });
    const r2 = await second.run({ passes: ["dedupe"] });
    expect(r2.passes.dedupe?.fallback).toBe(true);
    expect(r2.passes.dedupe?.notes[0]).toMatch(/schema/);
    expect(r2.passes.dedupe?.changed).toHaveLength(1);
  });

  it("contradiction: links both, tombstones the older when the newer supersedes", async () => {
    const { ynm, run } = make(
      new ScriptJudge((_s, id) =>
        id === "contradicts" ? 0.9 : id === "newerSupersedes" ? 0.9 : 0.1
      )
    );
    const old = await ynm.remember({
      type: "semantic",
      subject: "entity:staging",
      content: "Staging deploys to cluster blue",
    });
    const neu = await ynm.remember({
      type: "semantic",
      subject: "entity:staging",
      content: "Staging deploys to cluster green",
    });
    const r = await run({ passes: ["contradict"] });
    expect(r.passes.contradict?.changed).toEqual([old.memoryId]);
    const kept = await ynm.find(neu.memoryId);
    expect(kept?.links).toEqual([{ rel: "contradicts", to: old.memoryId }]);
    expect((await ynm.find(old.memoryId))?.tombstoned).toBe(true);
  });

  it("promote: explicit tag acts without a model; judge decides otherwise", async () => {
    const { ynm, run } = make(new ScriptJudge((_s, id) => (id === "usefulLater" ? 0.9 : 0)));
    await ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "Decided: always run the gate before tagging",
      tags: ["promote"],
      ttl: "PT1H",
    });
    await ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "Judge says durable",
      ttl: "PT1H",
    });
    const r = await run({ passes: ["promote"] });
    expect(r.passes.promote?.changed).toHaveLength(2);
    const promoted = await ynm.list({ includeTombstoned: false });
    expect(promoted.every((m) => m.type !== "working")).toBe(true);
    expect(promoted.map((m) => m.namespace)).toEqual(["user/u", "user/u"]);
    expect(promoted[0]?.links[0]?.rel).toBe("derives-from");
  });

  it("reflect: writes a verified reflective memory per subject, or withholds it when flagged", async () => {
    const writer: Writer = {
      name: "fake",
      write: async () => ({
        value: {
          summary: "Releases slip when the gate is skipped",
          content: "Across three releases, skipping the gate caused rework.",
        },
        model: "fake",
      }),
    };
    const clean = make(new ScriptJudge(() => 0.05), writer);
    for (let i = 0; i < 3; i++)
      await clean.ynm.remember({
        type: "episodic",
        subject: "topic:release",
        content: `Release ${i}: gate skipped, rework followed`,
        tags: ["release"],
      });
    const r = await clean.run({ passes: ["reflect"] });
    expect(r.passes.reflect?.changed).toHaveLength(1);
    const refl = (await clean.ynm.list({ type: "reflective", includeTombstoned: false }))[0];
    expect(refl?.subject).toBe("topic:release");
    expect(refl?.links).toHaveLength(3);
    const again = await clean.run({ passes: ["reflect"] });
    expect(again.passes.reflect?.candidates).toBe(0);
    const flagged = make(new ScriptJudge((_s, id) => (id === "unsupported" ? 0.9 : 0.05)), writer);
    for (let i = 0; i < 3; i++)
      await flagged.ynm.remember({ type: "episodic", subject: "topic:x", content: `Event ${i}` });
    const r2 = await flagged.run({ passes: ["reflect"] });
    expect(r2.passes.reflect?.changed).toEqual([]);
    expect(r2.passes.reflect?.flagged).toHaveLength(3);
    expect((await flagged.ynm.list({ type: "reflective", includeTombstoned: false })).length).toBe(
      0
    );
  });

  it("normalise turns relative dates absolute from recordedAt", async () => {
    expect(
      absolutise(
        "Deployed yesterday and again 3 days ago; review next week.",
        "2026-09-29T12:00:00.000Z"
      )
    ).toBe("Deployed 2026-09-28 and again 2026-09-26; review the week of 2026-10-06.");
    const { ynm, run } = make(new HeuristicJudge());
    const m = await ynm.remember({ type: "episodic", content: "Outage happened yesterday." });
    const r = await run({ passes: ["normalise"] });
    expect(r.passes.normalise?.changed).toEqual([m.memoryId]);
    expect((await ynm.find(m.memoryId))?.current.content).toMatch(/Outage happened 2026-09-28/);
  });

  it("respects the pair cap and reports it as skipped", async () => {
    const { ynm, run } = make(new ScriptJudge(() => 0.95));
    for (let i = 0; i < 6; i++)
      await ynm.remember({ type: "semantic", content: `same thing number ${i}` });
    const r = await run({ passes: ["dedupe"], maxPairs: 2 });
    expect(r.passes.dedupe?.judged).toBe(2);
    expect(r.passes.dedupe?.skipped).toBeGreaterThan(0);
  });
});

/** The same answers as `inner`, reported as uncalibrated guesses. */
function uncalibrated(inner: Judge): Judge {
  return {
    name: "uncalibrated",
    calibrated: false,
    limits: () => inner.limits(),
    async judge<Q extends Record<string, Question>>(state: unknown, questions: Q) {
      return { ...(await inner.judge(state as never, questions)), calibrated: false };
    },
  };
}

const fixedWriter = (value: { summary: string; content: string }): Writer => ({
  name: "fake",
  write: async <T>() => ({
    value: value as T,
    model: "fake",
    usage: { inputTokens: 5, outputTokens: 5 },
  }),
});

describe("dream passes: expire and promote", () => {
  it("expire runs on the engine clock, skips memory without a ttl, and honours dry runs", async () => {
    const { ynm } = make(new HeuristicJudge());
    const due = await ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "short-lived",
      ttl: "PT1S",
    });
    // Written by another tool without a ttl: never a candidate for expiry.
    await ynm
      .mount("personal")
      .log.append([
        makeRecord({ type: "working", namespace: "session/s1", content: "no ttl at all" }),
      ]);
    const config = DreamConfigSchema.parse({});
    const opts = { judge: new HeuristicJudge(), writer: new NoneWriter(), config };
    const dry = await dream(ynm, { passes: ["expire"], dryRun: true }, opts);
    expect(dry.passes.expire).toMatchObject({ candidates: 1, changed: [due.memoryId] });
    expect((await ynm.find(due.memoryId))?.tombstoned).toBe(false);
    const real = await dream(ynm, { passes: ["expire"] }, opts);
    expect(real.passes.expire?.changed).toEqual([due.memoryId]);
    expect((await ynm.find(due.memoryId))?.tombstoned).toBe(true);
    expect(real.estimatedCostUsd).toBe(0);
  });

  it("promote maps the judged kind onto the new memory type", async () => {
    for (const [v, type] of [
      [1, "episodic"],
      [2, "procedural"],
      [3, "reference"],
    ] as const) {
      const { ynm, run } = make(new ScriptJudge((_s, id) => (id === "usefulLater" ? 0.95 : v)));
      await ynm.remember({ type: "working", namespace: "session/s1", content: `keep as ${type}` });
      const r = await run({ passes: ["promote"] });
      expect(r.passes.promote?.changed).toHaveLength(1);
      const [created] = await ynm.list({ includeTombstoned: false });
      expect(created?.type).toBe(type);
      const stored = created?.current.data as { judgments?: unknown[] } | undefined;
      expect(stored?.judgments).toHaveLength(1);
    }
  });

  it("promote flags for review when uncalibrated, ignores useless scratch and respects the cap", async () => {
    const review = make(
      uncalibrated(new ScriptJudge((_s, id) => (id === "usefulLater" ? 0.95 : 0)))
    );
    const w = await review.ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "maybe durable",
    });
    const r = await review.run({ passes: ["promote"] });
    expect(r.passes.promote).toMatchObject({ changed: [], flagged: [w.memoryId], fallback: true });
    expect((await review.ynm.find(w.memoryId))?.needsReview).toBe(true);

    const ignore = make(new ScriptJudge(() => 0.1));
    await ignore.ynm.remember({ type: "working", namespace: "session/s1", content: "scratch" });
    const ri = await ignore.run({ passes: ["promote"] });
    expect(ri.passes.promote).toMatchObject({ judged: 1, changed: [], flagged: [] });

    const capped = make(new ScriptJudge((_s, id) => (id === "usefulLater" ? 0.95 : 0)));
    await capped.ynm.remember({ type: "working", namespace: "session/s1", content: "one" });
    await capped.ynm.remember({ type: "working", namespace: "session/s1", content: "two" });
    const tagged = await capped.ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "tagged",
      tags: ["promote"],
    });
    const rc = await capped.run({ passes: ["promote"], maxPairs: 1, dryRun: true });
    expect(rc.passes.promote).toMatchObject({ judged: 1, skipped: 1 });
    expect(rc.passes.promote?.changed).toContain(tagged.memoryId);
    expect(
      (
        await capped.ynm.list({
          type: "working",
          namespace: "session/s1",
          includeTombstoned: false,
        })
      ).length
    ).toBe(3);
  });
});

describe("dream passes: dedupe and contradict", () => {
  it("dedupe hands likely contradictions to the contradiction pass", async () => {
    const { ynm, run } = make(
      new ScriptJudge((_s, id) =>
        id === "sameFact" ? 0.1 : id === "contradicts" ? 0.95 : id === "newerSupersedes" ? 0.95 : 0
      )
    );
    const a = await ynm.remember({
      type: "semantic",
      content: "The cache lives in redis cluster a",
    });
    const b = await ynm.remember({
      type: "semantic",
      content: "The cache lives in redis cluster b",
    });
    const r = await run({ passes: ["dedupe", "contradict"] });
    expect(r.passes.dedupe?.changed).toEqual([]);
    expect(r.passes.contradict?.candidates).toBe(1);
    expect(r.passes.contradict?.changed).toEqual([a.memoryId]);
    expect((await ynm.find(b.memoryId))?.links).toEqual([{ rel: "contradicts", to: a.memoryId }]);
  });

  it("dedupe without a writer annotates the survivor; a dry-run review flags nothing on disk", async () => {
    const review = make(new ScriptJudge((_s, id) => (id === "sameFact" ? 0.7 : 0)));
    await review.ynm.remember({ type: "semantic", content: "Builds use pnpm workspaces" });
    await review.ynm.remember({ type: "semantic", content: "Builds use pnpm workspaces too" });
    const r = await review.run({ passes: ["dedupe"], dryRun: true });
    expect(r.passes.dedupe?.flagged).toHaveLength(2);
    expect(await review.ynm.reviewQueue()).toEqual([]);
  });

  it("contradict ignores weak pairs, flags uncertain ones, skips over the cap and never pairs working memory", async () => {
    const weak = make(new ScriptJudge(() => 0.1));
    for (const c of ["Port is 8080", "Port is 9090"])
      await weak.ynm.remember({ type: "semantic", subject: "entity:port", content: c });
    await weak.ynm.remember({
      type: "working",
      namespace: "session/s1",
      subject: "entity:port",
      content: "trying 7070",
    });
    const rw = await weak.run({ passes: ["contradict"] });
    expect(rw.passes.contradict).toMatchObject({
      candidates: 1,
      judged: 1,
      changed: [],
      flagged: [],
    });

    const unsure = make(
      new ScriptJudge((_s, id) => (id === "contradicts" ? 0.9 : id === "newerSupersedes" ? 0.2 : 0))
    );
    const ids: string[] = [];
    for (const c of ["Port is 8080", "Port is 9090", "Port is 7070"])
      ids.push(
        (await unsure.ynm.remember({ type: "semantic", subject: "entity:port", content: c }))
          .memoryId
      );
    const dry = await unsure.run({ passes: ["contradict"], dryRun: true, maxPairs: 2 });
    expect(dry.passes.contradict).toMatchObject({ candidates: 3, judged: 2, skipped: 1 });
    expect(await unsure.ynm.reviewQueue()).toEqual([]);
    const ru = await unsure.run({ passes: ["contradict"] });
    expect(ru.passes.contradict?.changed).toEqual([]);
    expect(new Set(ru.passes.contradict?.flagged)).toEqual(new Set(ids));
    expect((await unsure.ynm.reviewQueue()).length).toBe(3);
  });
});

describe("dream passes: reflect and normalise", () => {
  async function episodes(ynm: Ynm, subject: string, n = 3): Promise<void> {
    for (let i = 0; i < n; i++)
      await ynm.remember({ type: "episodic", subject, content: `${subject} event ${i}` });
  }

  it("reflect is skipped without a writer and notes a writer failure", async () => {
    const none = make(new ScriptJudge(() => 0.05));
    await episodes(none.ynm, "topic:none");
    const rn = await none.run({ passes: ["reflect"] });
    expect(rn.passes.reflect).toMatchObject({ candidates: 1, skipped: 1, fallback: true });

    const failing: Writer = {
      name: "failing",
      write: async () => {
        throw new Error("endpoint down");
      },
    };
    const broken = make(new ScriptJudge(() => 0.05), failing);
    await episodes(broken.ynm, "topic:broken");
    await broken.ynm.remember({ type: "semantic", content: "no subject here" });
    const rb = await broken.run({ passes: ["reflect"] });
    expect(rb.passes.reflect?.skipped).toBe(1);
    expect(rb.passes.reflect?.notes).toEqual(["reflect skipped topic:broken: endpoint down"]);
  });

  it("reflect replaces an older reflection once new episodes arrive, and writes nothing in a dry run", async () => {
    const writer = fixedWriter({ summary: "Deploy pattern", content: "Deploys repeat a pattern." });
    const { ynm, run } = make(new ScriptJudge(() => 0.05), writer);
    await episodes(ynm, "topic:deploy");
    const first = await run({ passes: ["reflect"] });
    expect(first.passes.reflect?.changed).toHaveLength(1);
    expect(first.passes.reflect?.usage.inputTokens).toBeGreaterThan(0);
    const [old] = await ynm.list({ type: "reflective", includeTombstoned: false });
    await ynm.remember({ type: "episodic", subject: "topic:deploy", content: "another deploy" });
    const dry = await run({ passes: ["reflect"], dryRun: true });
    expect(dry.passes.reflect?.changed).toEqual(["personal:topic:deploy"]);
    expect(
      (await ynm.list({ type: "reflective", includeTombstoned: false })).map((m) => m.memoryId)
    ).toEqual([old?.memoryId]);
    await run({ passes: ["reflect"] });
    const now = await ynm.list({ type: "reflective", includeTombstoned: false });
    expect(now).toHaveLength(1);
    expect(now[0]?.memoryId).not.toBe(old?.memoryId);
    expect((await ynm.find(old?.memoryId ?? ""))?.tombstoned).toBe(true);
  });

  it("absolutises every relative phrase it knows", () => {
    expect(
      absolutise(
        "today, tomorrow, last week, this week, last month, next month, 1 day ago",
        "2026-09-29T12:00:00.000Z"
      )
    ).toBe(
      "2026-09-29, 2026-09-30, the week of 2026-09-22, the week of 2026-09-29, around 2026-08-30, around 2026-10-29, 2026-09-28"
    );
  });

  it("normalise reports but does not write in a dry run", async () => {
    const { ynm, run } = make(new HeuristicJudge());
    const m = await ynm.remember({ type: "episodic", content: "Shipped today." });
    await ynm.remember({ type: "episodic", content: "Shipped on 2026-09-01." });
    const r = await run({ passes: ["normalise"], dryRun: true });
    expect(r.passes.normalise).toMatchObject({ candidates: 1, changed: [m.memoryId] });
    expect((await ynm.find(m.memoryId))?.current.content).toBe("Shipped today.");
  });
});

/** Counts the judge calls a dream pass makes, leaving out the write path's own questions. */
class CountingJudge extends ScriptJudge {
  calls = 0;
  override async judge<Q extends Record<string, Question>>(
    state: unknown,
    questions: Q
  ): Promise<Judgment<Q>> {
    if (!("sensitive" in questions) && !("importance" in questions)) this.calls += 1;
    return super.judge(state, questions);
  }
}

describe("dream runs are incremental", () => {
  const unrelated = (_s: unknown, id: string) =>
    id === "sameFact" || id === "contradicts" ? 0.05 : 0.1;

  it("a second run with nothing new calls no model and runs only expiry", async () => {
    const judge = new CountingJudge(unrelated);
    const { ynm, run } = make(judge);
    await ynm.remember({
      type: "semantic",
      content: "Notes anchor to the root commit",
      subject: "entity:notes",
    });
    await ynm.remember({
      type: "semantic",
      content: "Notes are fetched on sync",
      subject: "entity:notes",
    });
    await ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "Looking at the sync path",
      ttl: "PT1H",
    });
    const first = await run({});
    expect(first.fresh).toBe(3);
    expect(first.dreamed).toBe(3);
    expect(judge.calls).toBeGreaterThan(0);
    judge.calls = 0;
    const second = await run({});
    expect(second.fresh).toBe(0);
    expect(second.dreamed).toBe(0);
    expect(judge.calls).toBe(0);
    expect(Object.keys(second.passes)).toEqual(["expire"]);
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("judges only pairs that involve a new memory", async () => {
    const judge = new CountingJudge(unrelated);
    const { ynm, run } = make(judge);
    for (const content of ["Alpha beta gamma", "Alpha beta delta", "Alpha beta epsilon"])
      await ynm.remember({ type: "semantic", content, subject: "entity:alpha" });
    await run({});
    const added = await ynm.remember({
      type: "semantic",
      content: "Alpha beta zeta",
      subject: "entity:alpha",
    });
    const seen: string[][] = [];
    const spy = new CountingJudge(unrelated);
    const inner = spy.judge.bind(spy);
    spy.judge = async (state, questions) => {
      const pair = state as { a?: { content: string }; b?: { content: string } };
      if (pair.a && pair.b) seen.push([pair.a.content, pair.b.content]);
      return inner(state, questions);
    };
    const r = await dream(
      ynm,
      {},
      { judge: spy, writer: new NoneWriter(), config: DreamConfigSchema.parse({}) }
    );
    expect(r.fresh).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.includes("Alpha beta zeta"))).toBe(true);
    expect((await ynm.find(added.memoryId))?.dreamed).toBeDefined();
  });

  it("a memory whose content changes is judged again; a flag or tag does not count", async () => {
    const judge = new CountingJudge(unrelated);
    const { ynm, run } = make(judge);
    const a = await ynm.remember({ type: "semantic", content: "Releases happen on Fridays" });
    await ynm.remember({ type: "semantic", content: "Releases are cut from develop" });
    await run({});
    await ynm.annotate({ memoryId: a.memoryId, tags: ["release"], needsReview: true });
    expect((await run({})).fresh).toBe(0);
    await ynm.supersede({ memoryId: a.memoryId, content: "Releases happen on Thursdays" });
    expect((await run({})).fresh).toBe(1);
  });

  it("a change of subject makes a memory fresh for the contradiction pass", async () => {
    const judge = new CountingJudge(unrelated);
    const { ynm, run } = make(judge);
    const a = await ynm.remember({ type: "semantic", content: "Deploys go out at noon" });
    await ynm.remember({
      type: "semantic",
      content: "Deploys go out at midnight",
      subject: "entity:deploy",
    });
    await run({});
    // The tools cannot re-subject a memory, but an imported or synced annotate record can.
    const prior = await ynm.find(a.memoryId);
    await ynm.mount("personal").log.append([
      makeRecord({
        op: "annotate",
        memoryId: a.memoryId,
        type: "semantic",
        namespace: prior?.namespace,
        subject: "entity:deploy",
        recordedAt: "2026-12-01T00:00:00.000Z",
      }),
    ]);
    const r = await run({});
    expect(r.fresh).toBe(1);
    expect(r.passes.contradict?.judged).toBe(1);
  });

  it("memories the pair cap defers stay fresh until a later run judges them", async () => {
    const judge = new CountingJudge(unrelated);
    const { ynm } = make(judge);
    for (const content of ["One two three", "One two four", "One two five", "One two six"])
      await ynm.remember({ type: "semantic", content, subject: "entity:one" });
    const config = DreamConfigSchema.parse({ maxPairsPerRun: 2 });
    const runCapped = () => dream(ynm, {}, { judge, writer: new NoneWriter(), config });
    const first = await runCapped();
    expect(first.fresh).toBe(4);
    expect(first.passes.contradict?.skipped).toBeGreaterThan(0);
    expect(first.dreamed).toBeLessThan(4);
    let last = first;
    for (let i = 0; i < 10 && last.fresh > 0; i++) last = await runCapped();
    expect(last.fresh).toBe(0);
  });

  it("a promote tag added later still promotes a working memory already dreamed", async () => {
    const judge = new CountingJudge((_s, id) => (id === "usefulLater" ? 0.05 : 0.1));
    const { ynm, run } = make(judge);
    const w = await ynm.remember({
      type: "working",
      namespace: "session/s1",
      content: "The flaky test is in sync.test.ts",
      ttl: "PT1H",
    });
    expect((await run({})).passes.promote?.changed).toEqual([]);
    await ynm.annotate({ memoryId: w.memoryId, tags: ["promote"] });
    judge.calls = 0;
    const r = await run({});
    expect(r.passes.promote?.changed).toEqual([w.memoryId]);
    expect(judge.calls).toBe(0);
  });

  it("a partial run judges only fresh memories but marks none", async () => {
    const { ynm, run } = make(new CountingJudge(unrelated));
    await ynm.remember({ type: "semantic", content: "Caches live under XDG_CACHE_HOME" });
    expect((await run({ passes: ["expire"] })).dreamed).toBe(0);
    expect((await run({ namespace: "common" })).dreamed).toBe(0);
    expect((await run({})).dreamed).toBe(1);
  });

  it("a different judge sees every memory afresh once", async () => {
    const { ynm, run } = make(new CountingJudge(unrelated));
    await ynm.remember({ type: "semantic", content: "Builds run on arm64" });
    await ynm.remember({ type: "semantic", content: "Builds run on x86" });
    await run({});
    const heuristic = {
      judge: new HeuristicJudge(),
      writer: new NoneWriter(),
      config: DreamConfigSchema.parse({}),
    };
    expect((await dream(ynm, {}, heuristic)).fresh).toBe(2);
    expect((await dream(ynm, {}, heuristic)).fresh).toBe(0);
  });

  it("a dry run marks nothing, and marking leaves updatedAt alone", async () => {
    const judge = new CountingJudge(unrelated);
    const { ynm, run } = make(judge);
    const m = await ynm.remember({ type: "semantic", content: "Index lives in the cache dir" });
    const before = (await ynm.find(m.memoryId))?.updatedAt;
    expect((await run({ dryRun: true })).dreamed).toBe(0);
    expect((await ynm.find(m.memoryId))?.dreamed).toBeUndefined();
    expect((await run({})).dreamed).toBe(1);
    const after = await ynm.find(m.memoryId);
    expect(after?.dreamed).toBe(`${after?.current.id}@script`);
    expect(after?.updatedAt).toBe(before);
  });
});

describe("dream types", () => {
  it("an uncalibrated judge never reaches the act band", () => {
    const t = { act: 0.8, review: 0.5 };
    expect(band(0.9, t, true)).toBe("act");
    expect(band(0.9, t, false)).toBe("review");
    expect(band(0.6, t, true)).toBe("review");
    expect(band(0.1, t, true)).toBe("ignore");
  });

  it("adding no usage leaves the total alone", () => {
    const total = { inputTokens: 3, outputTokens: 4 };
    addUsage(total);
    addUsage(total, { inputTokens: 1, outputTokens: 1 });
    expect(total).toEqual({ inputTokens: 4, outputTokens: 5 });
  });
});
