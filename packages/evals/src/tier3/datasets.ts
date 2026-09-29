import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One conversation (or haystack) with its questions, normalised across benchmarks. */
export interface BenchTurn {
  id: string;
  speaker: string;
  text: string;
}
export interface BenchSession {
  id: string;
  /** ISO 8601. */
  date: string;
  turns: BenchTurn[];
}
export interface BenchQuestion {
  id: string;
  question: string;
  answer: string;
  category: string;
  /** Ids of turns (LoCoMo) or sessions (LongMemEval) that hold the answer. */
  evidence: string[];
  evidenceKind: "turn" | "session";
  /** ISO 8601 when the benchmark gives one. */
  date?: string;
  /** The right answer is to say the information is not available. */
  abstain: boolean;
}
export interface BenchCase {
  id: string;
  sessions: BenchSession[];
  questions: BenchQuestion[];
}
export interface BenchDataset {
  name: "locomo" | "longmemeval-s";
  file: string;
  sha256: string;
  source: string;
  license: string;
  cases: BenchCase[];
}

/** Public sets are downloaded on demand and cached here, never committed (ADR-014). */
export function benchDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.YNM_BENCH_DIR ?? join(homedir(), ".ynm", "bench");
}

export const DATASET_FILES = {
  locomo: {
    file: "locomo10.json",
    source: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    license: "CC BY-NC 4.0",
  },
  "longmemeval-s": {
    file: "longmemeval_s_cleaned.json",
    source:
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
    license: "MIT",
  },
} as const;

export function datasetPath(name: keyof typeof DATASET_FILES, env?: NodeJS.ProcessEnv): string {
  return join(benchDir(env), DATASET_FILES[name].file);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** LoCoMo: "1:56 pm on 8 May, 2023". */
export function parseLocomoDate(s: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i.exec(
    s.trim()
  );
  if (!m) throw new Error(`unparseable LoCoMo date: ${s}`);
  let hour = Number(m[1]) % 12;
  if ((m[3] as string).toLowerCase() === "pm") hour += 12;
  const month = MONTHS.indexOf((m[5] as string).toLowerCase());
  if (month < 0) throw new Error(`unparseable LoCoMo month: ${s}`);
  return new Date(Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2]))).toISOString();
}

/** LongMemEval: "2023/05/20 (Sat) 02:21". */
export function parseLongMemEvalDate(s: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`unparseable LongMemEval date: ${s}`);
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  ).toISOString();
}

/** LoCoMo category ids as used by the paper's evaluation code. */
export const LOCOMO_CATEGORIES: Record<number, string> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown> & { speaker_a: string; speaker_b: string };
  qa: Array<{
    question: string;
    answer?: string | number;
    adversarial_answer?: string;
    evidence?: string[];
    category: number;
  }>;
}

export function loadLocomo(file = datasetPath("locomo")): BenchDataset {
  if (!existsSync(file))
    throw new Error(`LoCoMo not found at ${file}; download ${DATASET_FILES.locomo.source}`);
  const text = readFileSync(file, "utf8");
  const samples = JSON.parse(text) as LocomoSample[];
  const cases: BenchCase[] = samples.map((s) => {
    const conv = s.conversation;
    const sessions: BenchSession[] = [];
    for (const key of Object.keys(conv)) {
      const m = /^session_(\d+)$/.exec(key);
      if (!m) continue;
      const turns = conv[key] as Array<{
        speaker: string;
        dia_id: string;
        text: string;
        blip_caption?: string;
      }>;
      const date = parseLocomoDate(String(conv[`${key}_date_time`]));
      sessions.push({
        id: key,
        date,
        turns: turns.map((t) => ({
          id: t.dia_id,
          speaker: t.speaker,
          text: t.blip_caption ? `${t.text} [shared an image: ${t.blip_caption}]` : t.text,
        })),
      });
    }
    sessions.sort((a, b) => Number(a.id.slice(8)) - Number(b.id.slice(8)));
    const questions: BenchQuestion[] = s.qa.map((q, i) => ({
      id: `${s.sample_id}:q${i}`,
      question: q.question,
      answer: String(q.answer ?? q.adversarial_answer ?? ""),
      category: LOCOMO_CATEGORIES[q.category] ?? String(q.category),
      evidence: q.evidence ?? [],
      evidenceKind: "turn",
      abstain: q.category === 5,
    }));
    return { id: s.sample_id, sessions, questions };
  });
  return {
    name: "locomo",
    file,
    sha256: sha256(text),
    source: DATASET_FILES.locomo.source,
    license: DATASET_FILES.locomo.license,
    cases,
  };
}

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}

/** LongMemEval-S: each instance is its own haystack, so each becomes one case with one question. */
export function loadLongMemEval(file = datasetPath("longmemeval-s")): BenchDataset {
  if (!existsSync(file))
    throw new Error(
      `LongMemEval-S not found at ${file}; download ${DATASET_FILES["longmemeval-s"].source}`
    );
  const text = readFileSync(file, "utf8");
  const items = JSON.parse(text) as LongMemEvalInstance[];
  const cases: BenchCase[] = items.map((x) => {
    const sessions: BenchSession[] = x.haystack_sessions.map((turns, i) => ({
      id: x.haystack_session_ids[i] as string,
      date: parseLongMemEvalDate(x.haystack_dates[i] as string),
      turns: turns.map((t, j) => ({
        id: `${x.haystack_session_ids[i]}:${j}`,
        speaker: t.role,
        text: t.content,
      })),
    }));
    const abstain = x.question_id.endsWith("_abs");
    return {
      id: x.question_id,
      sessions,
      questions: [
        {
          id: x.question_id,
          question: x.question,
          answer: String(x.answer),
          category: abstain ? "abstention" : x.question_type,
          evidence: abstain ? [] : x.answer_session_ids,
          evidenceKind: "session",
          date: parseLongMemEvalDate(x.question_date),
          abstain,
        },
      ],
    };
  });
  return {
    name: "longmemeval-s",
    file,
    sha256: sha256(text),
    source: DATASET_FILES["longmemeval-s"].source,
    license: DATASET_FILES["longmemeval-s"].license,
    cases,
  };
}

/** Deterministic subset: a seeded shuffle, then the first `limit`. */
export function sampleCases(cases: BenchCase[], limit: number | undefined, seed = 1): BenchCase[] {
  if (!limit || limit >= cases.length) return cases;
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...cases];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as BenchCase, out[i] as BenchCase];
  }
  return out.slice(0, limit);
}
