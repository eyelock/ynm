import { z } from "zod";
import type {
  Answer,
  JsonValue,
  Judge,
  JudgeLimits,
  Judgment,
  Question,
  Writer,
} from "../types.js";

function answerSchema(q: Question): z.ZodType {
  switch (q.type) {
    case "noul":
      return z.object({ noul: z.number().min(0).max(1) });
    case "choice": {
      const keys = Object.keys(q.criteria) as [string, ...string[]];
      return z.object({ choice: z.enum(keys), confidence: z.number().min(0).max(1).default(0.5) });
    }
    case "score":
      return z.object({
        score: z
          .number()
          .int()
          .min(0)
          .max(q.criteria.length - 1),
        confidence: z.number().min(0).max(1).default(0.5),
      });
  }
}

/**
 * A Judge over any Writer: asks a generative model for the answers as JSON. Useful without a
 * TypeSafe key, but its probabilities are guesses; results are marked uncalibrated (ADR-012).
 */
export class WriterEmulatedJudge implements Judge {
  readonly name: string;
  readonly calibrated = false;
  constructor(private readonly writer: Writer) {
    this.name = `writer-emulated:${writer.name}`;
  }

  limits(): JudgeLimits {
    return { stateTokens: 60_000, requestTokens: 100_000, maxChoices: 50 };
  }

  async judge<Q extends Record<string, Question>>(
    state: JsonValue,
    questions: Q
  ): Promise<Judgment<Q>> {
    const shape: Record<string, z.ZodType> = {};
    for (const [id, q] of Object.entries(questions)) shape[id] = answerSchema(q);
    const schema = z.object(shape);
    const instructions = [
      "You are a careful, calibrated judge. Answer each question about the input strictly from the input.",
      "For a noul question give the probability (0..1) that the statement is true.",
      "For a choice question pick one option key and a confidence.",
      "For a score question give the integer level index and a confidence.",
      "Questions:",
      JSON.stringify(questions, null, 2),
    ].join("\n");
    const { value, model, usage } = await this.writer.write({
      instructions,
      state,
      schema,
      schemaName: "judgments",
    });
    const answers = {} as { [K in keyof Q]: Answer };
    for (const [id, q] of Object.entries(questions) as Array<[keyof Q, Question]>) {
      const v = (value as Record<string, Record<string, unknown>>)[id as string] ?? {};
      if (q.type === "noul") answers[id] = { type: "noul", noul: Number(v.noul ?? 0.5) };
      else if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const choice = String(v.choice);
        const conf = Number(v.confidence ?? 0.5);
        const rest = keys.length > 1 ? (1 - conf) / (keys.length - 1) : 0;
        answers[id] = {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? conf : rest])),
          confidence: conf,
        };
      } else {
        const score = Number(v.score ?? 0);
        const conf = Number(v.confidence ?? 0.5);
        answers[id] = {
          type: "score",
          score,
          legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), String(c)])),
          probabilities: { [String(score)]: conf },
          confidence: conf,
        };
      }
    }
    return { answers, model, calibrated: false, usage };
  }
}
