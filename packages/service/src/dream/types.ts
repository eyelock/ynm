import type { DreamConfig, StoredJudgment } from "@ynm/model";
import type { Judge, Judgment, Question, Usage, Writer } from "@ynm/models";
import type { Ynm } from "../ynm.js";

export type Band = "act" | "review" | "ignore";

export interface PassReport {
  candidates: number;
  judged: number;
  changed: string[];
  flagged: string[];
  skipped: number;
  /** True when the pass used its non-model fallback for at least one decision. */
  fallback: boolean;
  usage: Usage;
  notes: string[];
}

export interface DreamReport {
  dryRun: boolean;
  judge: { name: string; calibrated: boolean };
  writer: string;
  passes: Record<string, PassReport>;
  usage: Usage;
  /** Rough cost in USD from usage; Jev list price for calibrated judges, 0 for local models. */
  estimatedCostUsd: number;
}

export interface DreamContext {
  ynm: Ynm;
  judge: Judge;
  writer: Writer;
  config: DreamConfig;
  now: () => Date;
  dryRun: boolean;
  namespace?: string;
  maxPairs: number;
  /** Judgments so far in the current pass; reset by the engine before each pass. */
  pairsJudged: { n: number };
}

export function emptyReport(): PassReport {
  return {
    candidates: 0,
    judged: 0,
    changed: [],
    flagged: [],
    skipped: 0,
    fallback: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    notes: [],
  };
}

export function addUsage(into: Usage, u?: Usage): void {
  if (!u) return;
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
}

/**
 * Confidence bands (ADR-012). An uncalibrated judge never reaches "act": its probabilities are
 * guesses, so the most it can do is flag for review. Explicit user signals bypass this.
 */
export function band(p: number, t: { act: number; review: number }, calibrated: boolean): Band {
  if (p >= t.act) return calibrated ? "act" : "review";
  if (p >= t.review) return "review";
  return "ignore";
}

export function storedJudgment(
  pass: string,
  j: Judgment,
  questions: Record<string, Question>,
  at: string,
  b?: Band
): StoredJudgment {
  return {
    pass,
    model: j.model,
    calibrated: j.calibrated,
    at,
    questions,
    answers: j.answers,
    band: b,
    usage: j.usage,
  };
}

export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
