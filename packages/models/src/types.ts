import type { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** The three System One primitives (ADR-012). Question ids are for code; meaning goes in text. */
export type Question =
  | { type: "noul"; instructions: JsonValue; criteria?: { true: JsonValue; false: JsonValue } }
  | { type: "choice"; instructions: JsonValue; criteria: Record<string, JsonValue | null> }
  | { type: "score"; instructions: JsonValue; criteria: JsonValue[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Judgment<Q extends Record<string, Question> = Record<string, Question>> {
  answers: { [K in keyof Q]: Answer };
  model: string;
  /** False for heuristic and writer-emulated judges: probabilities are not calibrated. */
  calibrated: boolean;
  usage?: Usage;
}

export interface JudgeLimits {
  stateTokens: number;
  requestTokens: number;
  maxChoices: number;
}

/** Decision model seam (ADR-012). Typed questions in, typed answers with probabilities out. */
export interface Judge {
  readonly name: string;
  readonly calibrated: boolean;
  judge<Q extends Record<string, Question>>(state: JsonValue, questions: Q): Promise<Judgment<Q>>;
  limits(): JudgeLimits;
}

export interface WriteRequest<T> {
  instructions: string;
  state: JsonValue;
  schema: z.ZodType<T>;
  /** Name for the schema in prompts and json_schema modes. */
  schemaName?: string;
}

export interface Written<T> {
  value: T;
  model: string;
  usage?: Usage;
}

/** Generative seam with structured output (ADR-012): the result is validated or rejected. */
export interface Writer {
  readonly name: string;
  write<T>(req: WriteRequest<T>): Promise<Written<T>>;
}

export class ModelUnavailableError extends Error {
  constructor(what: string, why: string) {
    super(`${what} unavailable: ${why}`);
    this.name = "ModelUnavailableError";
  }
}

export class StructuredOutputError extends Error {
  constructor(
    readonly attempts: number,
    readonly issues: string
  ) {
    super(
      `writer output did not match the schema after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${issues}`
    );
    this.name = "StructuredOutputError";
  }
}

export function estimateTokens(v: JsonValue): number {
  return Math.ceil(JSON.stringify(v).length / 4);
}
