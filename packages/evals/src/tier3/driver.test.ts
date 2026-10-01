import { join } from "node:path";
import type { JsonValue, Judge, JudgeLimits, Judgment, Question, Writer } from "@ynm/models";
import { RELEASE_VERSION } from "../version.js";
import { type BenchDataset, loadLocomo, loadLongMemEval } from "./datasets.js";
import { runBenchmark } from "./driver.js";

const fixtures = join(import.meta.dirname, "..", "..", "test", "fixtures", "tier3");

/** Answers by echoing the retrieved memories' text, or "I don't know" when nothing came back. */
class EchoWriter implements Writer {
  readonly name = "echo-writer";
  readonly states: Array<Record<string, JsonValue>> = [];
  async write<T>(req: { state: JsonValue; schema: { parse(v: unknown): T } }) {
    const state = req.state as Record<string, JsonValue>;
    this.states.push(state);
    const memories = String(state.memories);
    const answer = memories
      ? memories
          .split("\n")
          .map((m) => m.replace(/^\d+\. \[[^\]]+\] /, ""))
          .join(" | ")
      : "I don't know.";
    return { value: req.schema.parse({ answer: ` ${answer} ` }), model: "echo" };
  }
}

/** Correct when the hypothesis mentions the gold answer; for abstention, when it declines. */
class ContainsJudge implements Judge {
  readonly name = "contains-judge";
  readonly calibrated = true;
  readonly seen: Array<{ state: Record<string, string>; instructions: string }> = [];
  limits(): JudgeLimits {
    return { stateTokens: 1_000_000, requestTokens: 1_000_000, maxChoices: 8 };
  }
  async judge<Q extends Record<string, Question>>(state: JsonValue, questions: Q) {
    const s = state as Record<string, string>;
    const instructions = String(questions.correct?.instructions);
    this.seen.push({ state: s, instructions });
    const declines = /know/i.test(s.hypothesis ?? "");
    const right = /not available/.test(instructions)
      ? declines
      : (s.hypothesis ?? "").toLowerCase().includes((s.gold ?? "").toLowerCase());
    return {
      answers: { correct: { type: "noul", noul: right ? 0.9 : 0.1 } },
      model: "contains",
      calibrated: true,
    } as unknown as Judgment<Q>;
  }
}

describe("tier3 benchmark driver: retrieval", () => {
  it("scores evidence recall per category on LoCoMo without a model", async () => {
    const ds = loadLocomo(join(fixtures, "locomo-mini.json"));
    const progress: string[] = [];
    const report = await runBenchmark(ds, ds.cases, { k: 10, onProgress: (m) => progress.push(m) });
    expect(report).toMatchObject({
      dataset: "locomo",
      datasetSha256: ds.sha256,
      datasetLicense: "CC BY-NC 4.0",
      ynmVersion: process.env.YNM_BASELINE_VERSION ?? RELEASE_VERSION,
      setup: { ingest: "turn-episodic", index: "sqlite-fts", k: 10, cases: 2, questions: 6 },
      timing: { memories: 5 },
    });
    expect(report.setup.writer).toBeUndefined();
    expect(report.answering).toBeUndefined();
    // Questions without evidence (the adversarial and the uncategorised one) are not scored.
    expect(report.retrieval.byCategory).toEqual({
      "single-hop": { n: 2, evidenceRecall: 1 },
      temporal: { n: 1, evidenceRecall: 1 },
      "multi-hop": { n: 1, evidenceRecall: 1 },
    });
    expect(report.retrieval.evidenceRecallAtK).toBe(1);
    expect(report.retrieval.fullEvidenceAtK).toBe(1);
    expect(progress).toEqual([
      "locomo: case 1/2, 5 questions, 4 memories",
      "locomo: case 2/2, 6 questions, 5 memories",
    ]);
  });

  it("matches LongMemEval evidence at session level and defaults k to 10", async () => {
    const ds = loadLongMemEval(join(fixtures, "longmemeval-mini.json"));
    const report = await runBenchmark(ds, ds.cases);
    expect(report.setup).toMatchObject({ k: 10, cases: 2, questions: 2 });
    expect(report.timing.memories).toBe(4);
    // The abstention instance has no evidence, so only one question is scored.
    expect(report.retrieval.byCategory).toEqual({
      "single-session-user": { n: 1, evidenceRecall: 1 },
    });
  });

  it("counts partial evidence, rounds to four places, and reports zero with nothing to score", async () => {
    const ds: BenchDataset = {
      name: "locomo",
      file: "inline",
      sha256: "inline-sha",
      source: "inline",
      license: "test",
      cases: [
        {
          id: "c",
          sessions: [
            {
              id: "session_1",
              date: "2024-02-01T10:00:00.000Z",
              turns: [
                { id: "D1:1", speaker: "Eve", text: "The lighthouse keeper paints watercolours." },
                { id: "D1:2", speaker: "Fay", text: "Marmalade is made from oranges." },
              ],
            },
          ],
          questions: [
            {
              id: "c:q0",
              question: "Who paints watercolours at the lighthouse?",
              answer: "the keeper",
              category: "single-hop",
              evidence: ["D1:1", "D7:7", "D8:8"],
              evidenceKind: "turn",
              abstain: false,
            },
          ],
        },
      ],
    };
    const report = await runBenchmark(ds, ds.cases, { k: 5 });
    expect(report.retrieval.evidenceRecallAtK).toBe(0.3333);
    expect(report.retrieval.fullEvidenceAtK).toBe(0);
    expect(report.retrieval.byCategory).toEqual({ "single-hop": { n: 1, evidenceRecall: 0.3333 } });

    const empty = await runBenchmark(ds, []);
    expect(empty.setup).toMatchObject({ cases: 0, questions: 0 });
    expect(empty.retrieval).toEqual({ evidenceRecallAtK: 0, fullEvidenceAtK: 0, byCategory: {} });
    expect(empty.timing.memories).toBe(0);
  });

  it("stamps the report with YNM_BASELINE_VERSION when set", async () => {
    vi.stubEnv("YNM_BASELINE_VERSION", "9.9.9-test");
    try {
      const ds = loadLongMemEval(join(fixtures, "longmemeval-mini.json"));
      expect((await runBenchmark(ds, [])).ynmVersion).toBe("9.9.9-test");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("tier3 benchmark driver: answering", () => {
  it("answers a bounded number of questions over dated memories and grades them", async () => {
    const ds = loadLocomo(join(fixtures, "locomo-mini.json"));
    const writer = new EchoWriter();
    const judge = new ContainsJudge();
    const report = await runBenchmark(ds, ds.cases, {
      k: 3,
      answer: { writer, judge, limit: 4 },
    });
    expect(report.setup).toMatchObject({
      writer: "echo-writer",
      judge: "contains-judge",
      judgeCalibrated: true,
    });
    expect(writer.states).toHaveLength(4);
    // LoCoMo gives no question date, so the question carries null and memories carry session dates.
    expect(writer.states[0]?.questionDate).toBeNull();
    expect(writer.states[0]?.question).toBe("What is the name of the greyhound Ada adopted?");
    expect(String(writer.states[0]?.memories)).toMatch(
      /^\d\. \[2023-05-08\] Ada: I adopted a greyhound named Pickles last week\.$/m
    );
    expect(String(writer.states[0]?.memories).split("\n").length).toBeLessThanOrEqual(3);

    const answering = report.answering;
    expect(answering?.n).toBe(4);
    expect(answering?.samples.map((s) => s.id)).toEqual([
      "conv-a:q0",
      "conv-a:q1",
      "conv-a:q2",
      "conv-a:q3",
    ]);
    const first = answering?.samples[0];
    expect(first).toMatchObject({ gold: "Pickles", correct: true, p: 0.9 });
    // The writer's padding is trimmed before grading.
    expect(first?.hypothesis).toBe(first?.hypothesis.trim());
    expect(judge.seen[0]?.state.hypothesis).toBe(first?.hypothesis);
    // The adversarial question is graded on declining, not on matching the gold.
    expect(judge.seen[3]?.instructions).toMatch(/not available/);
    expect(judge.seen[0]?.instructions).toMatch(/reference `gold`/);
    // The writer asserts what it retrieved instead of declining, so the adversarial one is wrong.
    expect(answering?.samples[3]).toMatchObject({ gold: "a telescope", correct: false, p: 0.1 });
    expect(answering?.accuracy).toBe(0.75);
    expect(answering?.byCategory).toEqual({
      "single-hop": { n: 1, accuracy: 1 },
      temporal: { n: 1, accuracy: 1 },
      "multi-hop": { n: 1, accuracy: 1 },
      adversarial: { n: 1, accuracy: 0 },
    });
  });

  it("passes the question date and grades abstention on LongMemEval", async () => {
    const ds = loadLongMemEval(join(fixtures, "longmemeval-mini.json"));
    const writer = new EchoWriter();
    const judge = new ContainsJudge();
    const report = await runBenchmark(ds, ds.cases, {
      k: 4,
      answer: { writer, judge, limit: 10 },
    });
    expect(writer.states.map((s) => s.questionDate)).toEqual([
      "2023-05-30T10:00:00.000Z",
      "2023-06-01T09:30:00.000Z",
    ]);
    expect(String(writer.states[0]?.memories)).toContain(
      "[2023-05-20] user: I bought a purple orchid for the kitchen window."
    );
    expect(report.answering?.samples[0]).toMatchObject({ id: "q-orchid", correct: true });
    // Nothing matches "bicycles", so the writer declines and abstention is graded correct.
    expect(writer.states[1]?.memories).toBe("");
    expect(report.answering?.samples[1]).toMatchObject({
      id: "q-bikes_abs",
      gold: "3",
      hypothesis: "I don't know.",
      correct: true,
    });
    expect(judge.seen[1]?.instructions).toMatch(/not available/);
    expect(report.answering?.byCategory).toEqual({
      "single-session-user": { n: 1, accuracy: 1 },
      abstention: { n: 1, accuracy: 1 },
    });
    expect(report.answering?.accuracy).toBe(1);
  });

  it("reports zero accuracy when the answer limit is zero", async () => {
    const ds = loadLongMemEval(join(fixtures, "longmemeval-mini.json"));
    const writer = new EchoWriter();
    const report = await runBenchmark(ds, ds.cases, {
      answer: { writer, judge: new ContainsJudge(), limit: 0 },
    });
    expect(writer.states).toHaveLength(0);
    expect(report.answering).toEqual({ n: 0, accuracy: 0, byCategory: {}, samples: [] });
  });
});
