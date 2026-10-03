import type { ConsolidateInput, DreamConfig } from "@ynm/model";
import { ConsolidateInputSchema } from "@ynm/model";
import type { Judge, Writer } from "@ynm/models";
import type { MemoryWithMount, Ynm } from "../ynm.js";
import { contradict, dedupe, expire, normalise, promote, reflect } from "./passes.js";
import {
  addUsage,
  type DreamContext,
  type DreamReport,
  dreamVersion,
  JEV_USD_PER_INPUT_TOKEN,
  type PassReport,
} from "./types.js";

export interface DreamOptions {
  judge: Judge;
  writer: Writer;
  config: DreamConfig;
  now?: () => Date;
}

/**
 * Runs the requested passes in order; every pass appends records only (ADR-006).
 *
 * A run judges only fresh memories: new, changed since a run with this judge last finished with
 * them (a `dreamed` mark on the memory), or never judged by it. With none fresh, only the expire
 * pass runs and no model is called; a working memory tagged `promote` is still promoted. A pair
 * is judged when at least one side is fresh, so two memories already compared are never compared
 * again; a memory with a judgment deferred by the pair cap stays fresh. Only a full run (every
 * pass, every namespace) marks: a partial one has not finished with anything.
 */
export async function dream(
  ynm: Ynm,
  raw: ConsolidateInput | Record<string, unknown>,
  opts: DreamOptions
): Promise<DreamReport> {
  const input = ConsolidateInputSchema.parse(raw);
  const before = await ynm.list({ namespace: input.namespace, includeTombstoned: false });
  const versionOf = (m: MemoryWithMount) => dreamVersion(m, opts.judge.name);
  const fresh = new Map(
    before.filter((m) => m.dreamed !== versionOf(m)).map((m) => [m.memoryId, versionOf(m)])
  );
  // A promote tag is acted on without a model, whenever it appears.
  const tagged = before.some((m) => m.type === "working" && m.tags.includes("promote"));
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
    fresh: new Set(fresh.keys()),
    deferred: new Set(),
    order: workingOrder(before),
  };
  const report: DreamReport = {
    dryRun: input.dryRun,
    judge: { name: opts.judge.name, calibrated: opts.judge.calibrated },
    writer: opts.writer.name,
    passes: {},
    fresh: fresh.size,
    dreamed: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
  };
  const flaggedPairs: Parameters<typeof contradict>[1] = [];
  const order = ["expire", "promote", "dedupe", "contradict", "reflect", "normalise"] as const;
  for (const name of order) {
    if (!input.passes.includes(name)) continue;
    // Expiry is due by time, not by change; every other pass works on fresh memories only.
    if (name !== "expire" && fresh.size === 0 && !tagged) continue;
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
  const full = !input.namespace && order.every((p) => input.passes.includes(p));
  if (!input.dryRun && full)
    report.dreamed = await markDreamed(ynm, input.namespace, fresh, ctx.deferred, versionOf);
  report.estimatedCostUsd = opts.judge.calibrated
    ? report.usage.inputTokens * JEV_USD_PER_INPUT_TOKEN
    : 0;
  return report;
}

/**
 * Newest first, fixed at the start of the run so a flag or merge mid-run reorders nothing. Under
 * the pair cap the newest memories are judged first: a new memory is the likeliest restatement of
 * an older one, and the newer side is the one a merge keeps.
 */
function workingOrder(memories: MemoryWithMount[]): Map<string, number> {
  const sorted = [...memories].sort(
    (x, y) =>
      (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0) ||
      (x.memoryId < y.memoryId ? 1 : x.memoryId > y.memoryId ? -1 : 0)
  );
  return new Map(sorted.map((m, i) => [m.memoryId, i]));
}

/**
 * Marks each fresh memory this run finished with, at the version it was judged at. One still
 * deferred, changed by the run (merged, superseded) or gone is left fresh for the next run.
 */
async function markDreamed(
  ynm: Ynm,
  namespace: string | undefined,
  fresh: Map<string, string>,
  deferred: Set<string>,
  versionOf: (m: MemoryWithMount) => string
): Promise<number> {
  let marked = 0;
  for (const m of await ynm.list({ namespace, includeTombstoned: false })) {
    const version = fresh.get(m.memoryId);
    if (!version || deferred.has(m.memoryId) || versionOf(m) !== version) continue;
    await ynm.annotate({ memoryId: m.memoryId, data: { dreamed: version } });
    marked += 1;
  }
  return marked;
}
