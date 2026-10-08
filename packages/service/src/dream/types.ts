import type { DreamConfig, StoredJudgment } from "@ynm/model";
import type { Judge, Judgment, Question, Usage, Writer } from "@ynm/models";
import type { MemoryWithMount, Ynm } from "../ynm.js";

export type Band = "act" | "review" | "ignore";

export interface PassReport {
  candidates: number;
  judged: number;
  changed: string[];
  flagged: string[];
  skipped: number;
  /**
   * True when the pass took its no-model path for at least one decision: the heuristic judge
   * answered, or a Writer step was skipped, absent or failed. A pass whose Writer ran and
   * wrote is not a fallback, whatever judge verified it.
   */
  fallback: boolean;
  /** True when an uncalibrated judge answered at least once; it can flag for review, never act. */
  uncalibrated: boolean;
  usage: Usage;
  notes: string[];
}

export interface DreamReport {
  dryRun: boolean;
  /**
   * False for a dry run without `judge`: passes that need a model listed their candidates and
   * judged none of them, so `changed` and `flagged` are empty for those passes.
   */
  judged: boolean;
  judge: { name: string; calibrated: boolean };
  writer: string;
  passes: Record<string, PassReport>;
  /** Memories new or changed since a run last finished with them; 0 means only expiry ran. */
  fresh: number;
  /** Memories this run finished with and marked, so later runs leave them alone. */
  dreamed: number;
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
  /** Whether the model-backed steps run: always for a real run, only on request for a dry one. */
  judging: boolean;
  namespace?: string;
  maxPairs: number;
  /** Judgments so far in the current pass; reset by the engine before each pass. */
  pairsJudged: { n: number };
  /** Memories to judge this run: new, or changed since a run last finished with them. */
  fresh: Set<string>;
  /** Fresh memories with a judgment left for a later run (the pair cap); they stay fresh. */
  deferred: Set<string>;
  /**
   * Each memory's place in the run's working order: newest first, as the run found them. Every
   * pass works through owners in this order, and a pair belongs to whichever side comes first.
   */
  order: Map<string, number>;
}

/**
 * What a dream run judges a memory by: its current content record, its subject (which an
 * annotate can change, and which decides the contradiction pairs) and the judge. Tags, links,
 * flags and other annotations, dream's own included, leave it alone; a different judge, say a
 * calibrated model after the heuristic, sees every memory afresh once.
 */
export function dreamVersion(m: MemoryWithMount, judge: string): string {
  return `${m.current.id}${m.subject ? `#${m.subject}` : ""}@${judge}`;
}

export function emptyReport(): PassReport {
  return {
    candidates: 0,
    judged: 0,
    changed: [],
    flagged: [],
    skipped: 0,
    fallback: false,
    uncalibrated: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    notes: [],
  };
}

/** Records on `r` what kind of judge answered: uncalibrated, and whether it was the heuristic. */
export function noteJudge(
  r: PassReport,
  ctx: Pick<DreamContext, "judge">,
  j: Pick<Judgment, "calibrated">
): void {
  if (!j.calibrated) r.uncalibrated = true;
  if (ctx.judge.name === "heuristic") r.fallback = true;
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
