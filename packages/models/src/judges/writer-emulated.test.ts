import type { WriteRequest, Writer, Written } from "../types.js";
import { WriterEmulatedJudge } from "./writer-emulated.js";

/** Records the request and returns a fixed value; lets tests check the schema the judge built. */
class CapturingWriter implements Writer {
  readonly name = "capture";
  req: WriteRequest<unknown> | undefined;
  constructor(private readonly value: unknown) {}
  async write<T>(req: WriteRequest<T>): Promise<Written<T>> {
    this.req = req as WriteRequest<unknown>;
    return {
      value: this.value as T,
      model: "cap-model",
      usage: { inputTokens: 7, outputTokens: 1 },
    };
  }
}

const questions = {
  same: { type: "noul" as const, instructions: "same?" },
  kind: { type: "choice" as const, instructions: "kind?", criteria: { a: null, b: null, c: null } },
  only: { type: "choice" as const, instructions: "only?", criteria: { solo: null } },
  level: { type: "score" as const, instructions: "level?", criteria: ["lo", "hi"] },
};

describe("WriterEmulatedJudge schema and defaults", () => {
  it("names itself after the writer and declares limits", () => {
    const j = new WriterEmulatedJudge(new CapturingWriter({}));
    expect(j.name).toBe("writer-emulated:capture");
    expect(j.limits()).toEqual({ stateTokens: 60_000, requestTokens: 100_000, maxChoices: 50 });
  });

  it("asks the writer with a schema that bounds each answer", async () => {
    const w = new CapturingWriter({});
    await new WriterEmulatedJudge(w).judge({ x: 1 }, questions);
    const req = w.req;
    expect(req?.schemaName).toBe("judgments");
    expect(req?.state).toEqual({ x: 1 });
    expect(req?.instructions).toContain('"kind"');
    const schema = req?.schema;
    expect(
      schema?.safeParse({
        same: { noul: 0.4 },
        kind: { choice: "b" },
        only: { choice: "solo", confidence: 1 },
        level: { score: 1 },
      }).success
    ).toBe(true);
    expect(
      schema?.safeParse({
        same: { noul: 1.5 },
        kind: { choice: "b" },
        only: { choice: "solo" },
        level: { score: 0 },
      }).success
    ).toBe(false);
    expect(
      schema?.safeParse({
        same: { noul: 0.5 },
        kind: { choice: "z" },
        only: { choice: "solo" },
        level: { score: 0 },
      }).success
    ).toBe(false);
    expect(
      schema?.safeParse({
        same: { noul: 0.5 },
        kind: { choice: "a" },
        only: { choice: "solo" },
        level: { score: 2 },
      }).success
    ).toBe(false);
  });

  it("fills defaults for missing fields and spreads the remaining probability", async () => {
    const j = new WriterEmulatedJudge(
      new CapturingWriter({ kind: { choice: "c", confidence: 0.6 }, only: { choice: "solo" } })
    );
    const r = await j.judge({}, questions);
    expect(r.answers.same).toEqual({ type: "noul", noul: 0.5 });
    const kind = r.answers.kind as { probabilities: Record<string, number> };
    expect(kind.probabilities.c).toBe(0.6);
    expect(kind.probabilities.a).toBeCloseTo(0.2);
    expect(kind.probabilities.b).toBeCloseTo(0.2);
    expect(r.answers.only).toEqual({
      type: "choice",
      choice: "solo",
      probabilities: { solo: 0.5 },
      confidence: 0.5,
    });
    expect(r.answers.level).toEqual({
      type: "score",
      score: 0,
      legend: { "0": "lo", "1": "hi" },
      probabilities: { "0": 0.5 },
      confidence: 0.5,
    });
    expect(r.model).toBe("cap-model");
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
  });
});
