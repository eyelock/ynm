import type { ConsolidateInput, DreamConfig } from "@ynm/model";
import { ConsolidateInputSchema } from "@ynm/model";
import type { Judge, Writer } from "@ynm/models";
import type { Ynm } from "../ynm.js";
import { contradict, dedupe, expire, normalise, promote, reflect } from "./passes.js";
import {
  addUsage,
  type DreamContext,
  type DreamReport,
  JEV_USD_PER_INPUT_TOKEN,
  type PassReport,
} from "./types.js";

export interface DreamOptions {
  judge: Judge;
  writer: Writer;
  config: DreamConfig;
  now?: () => Date;
}

/** Runs the requested passes in order; every pass appends records only (ADR-006). */
export async function dream(
  ynm: Ynm,
  raw: ConsolidateInput | Record<string, unknown>,
  opts: DreamOptions
): Promise<DreamReport> {
  const input = ConsolidateInputSchema.parse(raw);
  const ctx: DreamContext = {
    ynm,
    judge: opts.judge,
    writer: opts.writer,
    config: opts.config,
    now: opts.now ?? (() => new Date()),
    dryRun: input.dryRun,
    namespace: input.namespace,
    maxPairs: input.maxPairs ?? opts.config.maxPairsPerRun,
    pairsJudged: { n: 0 },
  };
  const report: DreamReport = {
    dryRun: input.dryRun,
    judge: { name: opts.judge.name, calibrated: opts.judge.calibrated },
    writer: opts.writer.name,
    passes: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
  };
  const flaggedPairs: Parameters<typeof contradict>[1] = [];
  const order = ["expire", "promote", "dedupe", "contradict", "reflect", "normalise"] as const;
  for (const name of order) {
    if (!input.passes.includes(name)) continue;
    // The pair cap applies per pass, so an expensive dedupe cannot starve contradiction.
    ctx.pairsJudged.n = 0;
    let pr: PassReport;
    switch (name) {
      case "expire":
        pr = await expire(ctx);
        break;
      case "promote":
        pr = await promote(ctx);
        break;
      case "dedupe":
        pr = await dedupe(ctx, flaggedPairs);
        break;
      case "contradict":
        pr = await contradict(ctx, flaggedPairs);
        break;
      case "reflect":
        pr = await reflect(ctx);
        break;
      case "normalise":
        pr = await normalise(ctx);
        break;
    }
    report.passes[name] = pr;
    addUsage(report.usage, pr.usage);
  }
  report.estimatedCostUsd = opts.judge.calibrated
    ? report.usage.inputTokens * JEV_USD_PER_INPUT_TOKEN
    : 0;
  return report;
}
