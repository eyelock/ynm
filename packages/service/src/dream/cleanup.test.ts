import type { JsonValue } from "@ynm/model";
import { DreamConfigSchema } from "@ynm/model";
import type { Judge, Judgment, Question } from "@ynm/models";
import { NoneWriter } from "@ynm/models";
import { MemoryLog } from "@ynm/store";
// The tier2 cleanup eval's corpus generator, so this free test seeds exactly the store that eval does.
import { generateCorpus } from "../../../evals/src/generator.js";
import { DEFAULT_REDACTION } from "../config.js";
import { IndexManager } from "../indexing.js";
import { Ynm } from "../ynm.js";
import { dream } from "./engine.js";

const key = (a: string, b: string) => [a, b].sort().join(":");

/**
 * An uncalibrated judge that knows the answer: a pair is the same fact exactly when the corpus
 * labels it a duplicate. Whatever it misses, it missed because the pair was never judged.
 */
class OracleJudge implements Judge {
  readonly name = "oracle";
  readonly calibrated = false;
  constructor(
    private readonly idOf: Map<string, string>,
    private readonly duplicates: Set<string>
  ) {}
  limits() {
    return { stateTokens: 1e6, requestTokens: 1e6, maxChoices: 255 };
  }
  async judge<Q extends Record<string, Question>>(
    state: JsonValue,
    questions: Q
  ): Promise<Judgment<Q>> {
    type Side = { content: string; updatedAt: string };
    const { a, b } = state as { a?: Side; b?: Side };
    const id = (s?: Side) => (s ? this.idOf.get(`${s.content}|${s.updatedAt}`) : undefined);
    const [ia, ib] = [id(a), id(b)];
    const same = ia && ib && this.duplicates.has(key(ia, ib)) ? 0.95 : 0.02;
    const answers = {} as Judgment<Q>["answers"];
    for (const [qid, q] of Object.entries(questions)) {
      const v = qid === "sameFact" ? same : 0.02;
      answers[qid as keyof Q] = (
        q.type === "noul"
          ? { type: "noul", noul: v }
          : { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 0.9 }
      ) as Judgment<Q>["answers"][keyof Q];
    }
    return { answers, model: "oracle", calibrated: false };
  }
}

describe("dream under the pair cap", () => {
  // Mirrors the tier2 cleanup eval: seed 77, 120 memories, 5% duplicates and 2% contradictions,
  // one run of expire, dedupe, contradict and normalise with the cap at twice the store.
  it("judges the cleanup eval's duplicates before the cap runs out", async () => {
    const SIZE = 120;
    const log = new MemoryLog("personal", "personal");
    const corpus = generateCorpus({
      level: "personal",
      namespaces: ["user/eval"],
      seed: 77,
      count: SIZE,
      duplicateRate: 0.05,
      contradictionRate: 0.02,
    });
    await log.append(corpus.records);
    let t = Date.parse("2026-10-01T00:00:00.000Z");
    const now = () => {
      t += 1000;
      return new Date(t);
    };
    const config = DreamConfigSchema.parse({ judgeOnWrite: false });
    const idOf = new Map<string, string>();
    const duplicates = new Set(corpus.duplicates.map(([a, b]) => key(a, b)));
    const judge = new OracleJudge(idOf, duplicates);
    const writer = new NoneWriter();
    const ynm = new Ynm({
      mounts: [{ id: "personal", level: "personal", location: "mem", log }],
      actor: "eval",
      userId: "eval",
      redaction: DEFAULT_REDACTION,
      index: new IndexManager("sqlite-fts", { fileFor: () => ":memory:" }),
      models: { judge, writer, resolution: { judge: judge.name, writer: writer.name } },
      dream: config,
      now,
    });
    for (const m of await ynm.list())
      idOf.set(`${(m.current.content ?? "").slice(0, 2000)}|${m.updatedAt}`, m.memoryId);

    const report = await dream(
      ynm,
      { passes: ["expire", "dedupe", "contradict", "normalise"], maxPairs: SIZE * 2 },
      { judge, writer, config, now }
    );

    // The cap binds: more candidate pairs than one run may judge.
    expect(report.passes.dedupe?.skipped).toBeGreaterThan(0);
    const found = new Set<string>();
    for (const r of await ynm.records({ includeTombstoned: true })) {
      const data = r.data as
        | { pair?: [string, string]; judgments?: Array<{ pass: string; band?: string }> }
        | undefined;
      if (
        data?.pair &&
        data.judgments?.[0]?.pass === "dedupe" &&
        data.judgments[0].band !== "ignore"
      )
        found.add(key(data.pair[0], data.pair[1]));
    }
    expect(duplicates.size).toBe(6);
    expect([...found].every((k) => duplicates.has(k))).toBe(true);
    // A pair belongs to whichever side's turn comes first, so it is judged at the earlier turn:
    // 5 of the 6 here. Owned by the later side, only 2 of them fit under the cap.
    expect(found.size).toBeGreaterThanOrEqual(5);
  });
});
