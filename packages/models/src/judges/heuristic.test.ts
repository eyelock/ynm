import type { Answer, JsonValue, Question } from "../types.js";
import { HeuristicJudge, jaccard } from "./heuristic.js";

const j = new HeuristicJudge();

async function noul(state: JsonValue, id: string): Promise<number> {
  const r = await j.judge(state, { [id]: { type: "noul", instructions: "?" } });
  return (r.answers[id] as { noul: number }).noul;
}

async function score(state: JsonValue, id: string, criteria: JsonValue[]): Promise<Answer> {
  const r = await j.judge(state, { [id]: { type: "score", instructions: "?", criteria } });
  return r.answers[id] as Answer;
}

describe("HeuristicJudge question ids", () => {
  it("declares generous limits and is uncalibrated", () => {
    expect(j.limits()).toEqual({
      stateTokens: 1_000_000,
      requestTokens: 1_000_000,
      maxChoices: 255,
    });
    expect(j.name).toBe("heuristic");
    expect(j.calibrated).toBe(false);
  });

  it("sameSubject follows similarity", async () => {
    expect(
      await noul({ a: "release process uses tags", b: "release process uses tags" }, "sameSubject")
    ).toBe(0.8);
    expect(await noul({ a: "release process", b: "database schema" }, "sameSubject")).toBe(0.2);
  });

  it("contradicts needs similar text with exactly one side negated", async () => {
    expect(
      await noul({ a: "the cache is enabled", b: "the cache is enabled" }, "contradicts")
    ).toBe(0.1);
    expect(
      await noul({ a: "deploys never on friday", b: "tests never flaky" }, "contradicts")
    ).toBe(0.1);
  });

  it("newerSupersedes is always undecided", async () => {
    expect(await noul({ a: "x", b: "y" }, "newerSupersedes")).toBe(0.5);
  });

  it("usefulLater looks for durable-knowledge words in memory", async () => {
    expect(await noul({ memory: "We always rebase before merging" }, "usefulLater")).toBe(0.7);
    expect(await noul({ memory: "had lunch" }, "usefulLater")).toBe(0.3);
    // Nested memory objects are flattened to text.
    expect(await noul({ memory: { body: ["prefer", "pnpm"] } as JsonValue }, "usefulLater")).toBe(
      0.7
    );
  });

  it("unsupported, lostFact and wrongDate compare summary to sources", async () => {
    const close = {
      summary: "notes anchored root commit",
      sources: ["notes anchored root commit"],
    };
    const far = { summary: "deploy target blue", sources: ["database migrations nightly"] };
    expect(await noul(close, "unsupported")).toBe(0.15);
    expect(await noul(far, "unsupported")).toBe(0.7);
    expect(await noul(close, "wrongDate")).toBe(0.15);
    expect(await noul(far, "wrongDate")).toBe(0.7);
    expect(await noul(close, "lostFact")).toBe(0.2);
    expect(await noul(far, "lostFact")).toBe(0.7);
  });

  it("sensitive flags secrets in memory", async () => {
    expect(await noul({ memory: "the api_key is abc" }, "sensitive")).toBe(0.9);
    expect(await noul({ memory: "the build uses vite" }, "sensitive")).toBe(0.05);
  });

  it("ignores non-object state and non-text fields", async () => {
    expect(await noul("a string state", "sameFact")).toBe(0);
    expect(await noul(["a", "b"], "sameFact")).toBe(0);
    expect(await noul(null, "sameFact")).toBe(0);
    expect(await noul({ a: 42, b: true }, "sameFact")).toBe(0);
  });

  it("relation scores 0, 1 or 2 by similarity with a matching legend", async () => {
    const criteria = ["different", "related", "same"];
    const diff = (await score({ a: "alpha beta", b: "gamma delta" }, "relation", criteria)) as {
      score: number;
      probabilities: Record<string, number>;
      legend: Record<string, string>;
    };
    expect(diff.score).toBe(0);
    expect(diff.probabilities).toEqual({ "0": 0.8, "1": 0.1, "2": 0.1 });
    expect(diff.legend).toEqual({ "0": "different", "1": "related", "2": "same" });
    const related = (await score(
      { a: "alpha beta gamma delta", b: "alpha beta epsilon zeta" },
      "relation",
      criteria
    )) as { score: number; probabilities: Record<string, number> };
    expect(related.score).toBe(1);
    expect(related.probabilities["1"]).toBe(0.8);
  });

  it("importance rates memories with strong words higher", async () => {
    const criteria = ["low", "mid", "high", "top"];
    const strong = (await score({ memory: "we must sign commits" }, "importance", criteria)) as {
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
    };
    expect(strong.score).toBe(2);
    expect(strong.probabilities).toEqual({ "2": 0.6 });
    expect(strong.confidence).toBe(0.3);
    const weak = (await score({ memory: "a note" }, "importance", criteria)) as { score: number };
    expect(weak.score).toBe(1);
  });

  it("unknown score questions get the mid level with zero confidence", async () => {
    const r = (await score({}, "other", ["a", "b", "c", "d", "e"])) as {
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
    };
    expect(r.score).toBe(2);
    expect(r.probabilities).toEqual({ "2": 0.2 });
    expect(r.confidence).toBe(0);
  });

  it("a choice with no options answers an empty choice", async () => {
    const q: Question = { type: "choice", instructions: "?", criteria: {} };
    const r = await j.judge({}, { pick: q });
    expect(r.answers.pick).toEqual({
      type: "choice",
      choice: "",
      probabilities: {},
      confidence: 0,
    });
  });

  it("reports estimated input usage", async () => {
    const r = await j.judge({ a: "abcd" }, {});
    expect(r.usage).toEqual({
      inputTokens: Math.ceil(JSON.stringify({ a: "abcd" }).length / 4),
      outputTokens: 0,
    });
    expect(jaccard("one two three", "one two three")).toBe(1);
  });
});
