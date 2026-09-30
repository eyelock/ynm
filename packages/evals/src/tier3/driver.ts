import { DreamConfigSchema } from "@ynm/model";
import type { Judge, Writer } from "@ynm/models";
import { DEFAULT_REDACTION, IndexManager, type RecallHit, Ynm } from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { z } from "zod";
import { RELEASE_VERSION } from "../version.js";
import type { BenchCase, BenchDataset, BenchQuestion } from "./datasets.js";

export interface AnswerOptions {
  writer: Writer;
  judge: Judge;
  /** Answer at most this many questions per run (paid models; keep small). */
  limit: number;
}

export interface BenchOptions {
  /** Memories retrieved per question. */
  k?: number;
  answer?: AnswerOptions;
  onProgress?: (msg: string) => void;
}

export interface CategoryStat {
  n: number;
  evidenceRecall: number;
}

export interface BenchReport {
  dataset: BenchDataset["name"];
  datasetSha256: string;
  datasetLicense: string;
  ranAt: string;
  ynmVersion: string;
  setup: {
    ingest: "turn-episodic";
    index: string;
    k: number;
    cases: number;
    questions: number;
    writer?: string;
    judge?: string;
    judgeCalibrated?: boolean;
  };
  retrieval: {
    /** Mean over questions with evidence of |evidence ∩ retrieved| / |evidence| at k. */
    evidenceRecallAtK: number;
    /** Fraction of questions whose evidence set is fully retrieved. */
    fullEvidenceAtK: number;
    byCategory: Record<string, CategoryStat>;
  };
  answering?: {
    n: number;
    accuracy: number;
    byCategory: Record<string, { n: number; accuracy: number }>;
    samples: Array<{
      id: string;
      question: string;
      gold: string;
      hypothesis: string;
      correct: boolean;
      p: number;
    }>;
  };
  timing: { ingestMs: number; memories: number; recallMs: number };
}

const AnswerSchema = z.object({ answer: z.string().min(1) });

/** A fresh in-memory store per case: MemoryLog plus the sqlite FTS index, clock driven by session dates. */
function storeFor(): { ynm: Ynm; clock: { t: number } } {
  const clock = { t: 0 };
  const ynm = new Ynm({
    mounts: [
      {
        id: "personal",
        level: "personal",
        location: "mem",
        log: new MemoryLog("bench", "personal"),
      },
    ],
    actor: "bench",
    userId: "bench",
    redaction: DEFAULT_REDACTION,
    index: new IndexManager("sqlite-fts", { fileFor: () => ":memory:" }),
    dream: DreamConfigSchema.parse({ judgeOnWrite: false }),
    now: () => new Date(clock.t),
  });
  return { ynm, clock };
}

/** Memory content is capped at 64k characters (ADR-002); a handful of LongMemEval turns exceed it. */
function clip(text: string, max = 60_000): string {
  return text.length > max ? `${text.slice(0, max)} [truncated]` : text;
}

/** Ingest: one episodic memory per turn, tagged with its session and turn ids, dated by the session. */
async function ingest(ynm: Ynm, clock: { t: number }, c: BenchCase): Promise<number> {
  let n = 0;
  for (const s of c.sessions) {
    const base = Date.parse(s.date);
    for (const [i, t] of s.turns.entries()) {
      clock.t = base + i * 1000;
      await ynm.remember({
        type: "episodic",
        content: clip(`${t.speaker}: ${t.text}`),
        subject: t.speaker,
        tags: [`s:${s.id}`, `t:${t.id}`],
        session: s.id,
        source: t.id,
        validFrom: s.date,
      });
      n += 1;
    }
  }
  return n;
}

function retrievedIds(hits: RecallHit[], kind: BenchQuestion["evidenceKind"]): Set<string> {
  const prefix = kind === "turn" ? "t:" : "s:";
  const out = new Set<string>();
  for (const h of hits) for (const tag of h.tags) if (tag.startsWith(prefix)) out.add(tag.slice(2));
  return out;
}

async function answer(
  opts: AnswerOptions,
  q: BenchQuestion,
  hits: RecallHit[]
): Promise<{ hypothesis: string; correct: boolean; p: number }> {
  const memories = hits
    .map((h, i) => `${i + 1}. [${h.updatedAt.slice(0, 10)}] ${h.content}`)
    .join("\n");
  const { value } = await opts.writer.write({
    instructions:
      "Answer the question using only the memories. Be brief: a short phrase or one sentence. If the memories do not contain the answer, reply exactly: I don't know.",
    state: { questionDate: q.date ?? null, question: q.question, memories },
    schema: AnswerSchema,
    schemaName: "answer",
  });
  const hypothesis = value.answer.trim();
  const questions = q.abstain
    ? {
        correct: {
          type: "noul" as const,
          instructions:
            "The right response to `question` is to say the information is not available. Does `hypothesis` decline to answer or say it does not know, rather than asserting an answer?",
        },
      }
    : {
        correct: {
          type: "noul" as const,
          instructions:
            "Does `hypothesis` convey the same answer to `question` as the reference `gold`? Differences in wording, formatting, or extra correct detail are fine; a different fact, date, or number is not.",
        },
      };
  const j = await opts.judge.judge({ question: q.question, gold: q.answer, hypothesis }, questions);
  const p = (j.answers.correct as { noul: number }).noul;
  return { hypothesis, correct: p >= 0.5, p };
}

/**
 * Tier 3 driver (ADR-014): feeds each conversation into memory as turn-level episodic memories,
 * retrieves for each question, and reports evidence recall (no model needed). With `answer`
 * set, a bounded number of questions are answered by the Writer over the retrieved memories
 * and graded by the Judge.
 */
export async function runBenchmark(
  dataset: BenchDataset,
  cases: BenchCase[],
  opts: BenchOptions = {}
): Promise<BenchReport> {
  const k = opts.k ?? 10;
  const byCat = new Map<string, { n: number; sum: number }>();
  const ans = new Map<string, { n: number; correct: number }>();
  const samples: NonNullable<BenchReport["answering"]>["samples"] = [];
  let questions = 0;
  let withEvidence = 0;
  let recallSum = 0;
  let full = 0;
  let answered = 0;
  let memories = 0;
  let ingestMs = 0;
  let recallMs = 0;
  for (const [ci, c] of cases.entries()) {
    const { ynm, clock } = storeFor();
    const t0 = performance.now();
    memories += await ingest(ynm, clock, c);
    ingestMs += performance.now() - t0;
    for (const q of c.questions) {
      questions += 1;
      if (q.date) clock.t = Date.parse(q.date);
      else clock.t += 60_000;
      const t1 = performance.now();
      const hits = await ynm.recall({ text: q.question, limit: k, rerank: false });
      recallMs += performance.now() - t1;
      if (q.evidence.length > 0) {
        const got = retrievedIds(hits, q.evidenceKind);
        const found = q.evidence.filter((e) => got.has(e)).length;
        const r = found / q.evidence.length;
        withEvidence += 1;
        recallSum += r;
        if (found === q.evidence.length) full += 1;
        const cat = byCat.get(q.category) ?? { n: 0, sum: 0 };
        cat.n += 1;
        cat.sum += r;
        byCat.set(q.category, cat);
      }
      if (opts.answer && answered < opts.answer.limit) {
        answered += 1;
        const a = await answer(opts.answer, q, hits);
        const cat = ans.get(q.category) ?? { n: 0, correct: 0 };
        cat.n += 1;
        if (a.correct) cat.correct += 1;
        ans.set(q.category, cat);
        samples.push({
          id: q.id,
          question: q.question,
          gold: q.answer,
          hypothesis: a.hypothesis,
          correct: a.correct,
          p: a.p,
        });
      }
    }
    opts.onProgress?.(
      `${dataset.name}: case ${ci + 1}/${cases.length}, ${questions} questions, ${memories} memories`
    );
  }
  const report: BenchReport = {
    dataset: dataset.name,
    datasetSha256: dataset.sha256,
    datasetLicense: dataset.license,
    ranAt: new Date().toISOString(),
    ynmVersion: process.env.YNM_BASELINE_VERSION ?? RELEASE_VERSION,
    setup: {
      ingest: "turn-episodic",
      index: "sqlite-fts",
      k,
      cases: cases.length,
      questions,
      ...(opts.answer
        ? {
            writer: opts.answer.writer.name,
            judge: opts.answer.judge.name,
            judgeCalibrated: opts.answer.judge.calibrated,
          }
        : {}),
    },
    retrieval: {
      evidenceRecallAtK: withEvidence ? round(recallSum / withEvidence) : 0,
      fullEvidenceAtK: withEvidence ? round(full / withEvidence) : 0,
      byCategory: Object.fromEntries(
        [...byCat].map(([k, v]) => [k, { n: v.n, evidenceRecall: round(v.sum / v.n) }])
      ),
    },
    timing: { ingestMs: Math.round(ingestMs), memories, recallMs: Math.round(recallMs) },
  };
  if (opts.answer) {
    const total = [...ans.values()].reduce((a, v) => a + v.n, 0);
    const correct = [...ans.values()].reduce((a, v) => a + v.correct, 0);
    report.answering = {
      n: total,
      accuracy: total ? round(correct / total) : 0,
      byCategory: Object.fromEntries(
        [...ans].map(([k, v]) => [k, { n: v.n, accuracy: round(v.correct / v.n) }])
      ),
      samples,
    };
  }
  return report;
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
