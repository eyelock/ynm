import { DreamConfigSchema } from "@ynm/model";
import type { Judge, Judgment, Question } from "@ynm/models";
import { HeuristicJudge, NoneWriter, type Writer } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
import { DEFAULT_REDACTION } from "../config.js";
import { IndexManager } from "../indexing.js";
import { Ynm } from "../ynm.js";
import { dream } from "./engine.js";
import { absolutise } from "./passes.js";

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
