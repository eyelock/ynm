import { join } from "node:path";
import { DreamConfigSchema } from "@ynm/model";
import {
  HeuristicJudge,
  type Judge,
  NoneWriter,
  resolveModels,
  SpendGuard,
  TypeSafeJudge,
  type Writer,
} from "@ynm/models";
import { DEFAULT_REDACTION, IndexManager, loadEnvFile, Ynm } from "@ynm/service";
import { MemoryLog } from "@ynm/store";
import { type GenerateOptions, generateCorpus } from "../generator.js";

export const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
loadEnvFile(repoRoot, process.env, ".env");

/** Judges available on this machine; the calibrated one only with a key (cost-capped by callers). */
/**
 * Evals spend real money only when opted in (YNM_EVAL_CALIBRATED=1) and never more than
 * YNM_EVAL_TOKEN_BUDGET input tokens per suite (default 150k, about $0.006 at Jev list price).
 */
export const EVAL_GUARD = new SpendGuard(
  Number(process.env.YNM_EVAL_TOKEN_BUDGET ?? 250_000),
  "evals"
);

export function availableJudges(): Judge[] {
  const out: Judge[] = [new HeuristicJudge()];
  if (process.env.TYPESAFE_API_KEY && process.env.YNM_EVAL_CALIBRATED === "1")
    out.push(new TypeSafeJudge({ apiKey: process.env.TYPESAFE_API_KEY, guard: EVAL_GUARD }));
  return out;
}

export function availableWriter(): Writer {
  const m = resolveModels(undefined, process.env, {
    claudeCli: process.env.YNM_EVAL_CLAUDE_CLI === "1",
  });
  return m.writer.name === "none" ? new NoneWriter() : m.writer;
}

export interface Seeded {
  ynm: Ynm;
  corpus: ReturnType<typeof generateCorpus>;
  config: ReturnType<typeof DreamConfigSchema.parse>;
  now: () => Date;
}

/** A store loaded with a synthetic corpus and a memory-backed sqlite index; no write-path judge. */
export async function seeded(opts: GenerateOptions, judge: Judge, writer: Writer): Promise<Seeded> {
  const log = new MemoryLog("personal", "personal");
  const corpus = generateCorpus({ level: "personal", namespaces: ["user/eval"], ...opts });
  await log.append(corpus.records);
  let t = Date.parse("2026-10-01T00:00:00.000Z");
  const now = () => {
    t += 1000;
    return new Date(t);
  };
  const config = DreamConfigSchema.parse({ judgeOnWrite: false });
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
  return { ynm, corpus, config, now };
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export function precisionRecall(
  predicted: Set<string>,
  truth: Set<string>
): { precision: number; recall: number; tp: number } {
  let tp = 0;
  for (const k of predicted) if (truth.has(k)) tp += 1;
  return {
    precision: predicted.size ? tp / predicted.size : 1,
    recall: truth.size ? tp / truth.size : 1,
    tp,
  };
}

export function judgeTag(j: Judge): string {
  return j.name.replace(/[^a-z0-9-]+/gi, "-");
}
