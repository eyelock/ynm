import type { ConsolidateInput, DreamConfig } from "@ynm/model";
import { ConsolidateInputSchema } from "@ynm/model";
import type { Judge, Writer } from "@ynm/models";
import {
  ATTR_YNM_DREAM_CANDIDATES,
  ATTR_YNM_DREAM_CHANGED,
  ATTR_YNM_DREAM_DREAMED,
  ATTR_YNM_DREAM_DRY_RUN,
  ATTR_YNM_DREAM_FLAGGED,
  ATTR_YNM_DREAM_FRESH,
  ATTR_YNM_DREAM_JUDGE,
  ATTR_YNM_DREAM_JUDGED,
  ATTR_YNM_DREAM_PASS,
  EVENT_YNM_DREAM_PASS_STARTED,
  EVENT_YNM_DREAM_STARTED,
  METRIC_YNM_DREAM_PASS_DURATION,
  withSpan,
} from "@ynm/telemetry";
import type { MemoryWithMount, Ynm } from "../ynm.js";
import { contradict, dedupe, expire, normalise, promote, reflect, retain } from "./passes.js";
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
 * pass (TTL expiry, then occurrence retention, reported as `retention`) runs and no model is
 * called; a working memory tagged `promote` is still promoted. A pair
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
  // One span per run and one per pass (ADR-018): counts only, never a memory.
  return withSpan(
    "dream",
    {
      started: EVENT_YNM_DREAM_STARTED,
      attributes: {
        [ATTR_YNM_DREAM_DRY_RUN]: input.dryRun,
        [ATTR_YNM_DREAM_JUDGE]: opts.judge.name,
      },
    },
    async (span) => {
      const report = await run(ynm, input, opts);
      span.set({ [ATTR_YNM_DREAM_FRESH]: report.fresh, [ATTR_YNM_DREAM_DREAMED]: report.dreamed });
      return report;
    }
  );
}

/** One consolidation pass as a span, with what it considered and changed. */
function passSpan(name: string, fn: () => Promise<PassReport>): Promise<PassReport> {
  return withSpan(
    `dream ${name}`,
    {
      started: EVENT_YNM_DREAM_PASS_STARTED,
      metric: METRIC_YNM_DREAM_PASS_DURATION,
      attributes: { [ATTR_YNM_DREAM_PASS]: name },
    },
    async (span) => {
      const pr = await fn();
      span.set({
        [ATTR_YNM_DREAM_CANDIDATES]: pr.candidates,
        [ATTR_YNM_DREAM_JUDGED]: pr.judged,
        [ATTR_YNM_DREAM_CHANGED]: pr.changed.length,
        [ATTR_YNM_DREAM_FLAGGED]: pr.flagged.length,
      });
      return pr;
    }
  );
}

async function run(ynm: Ynm, input: ConsolidateInput, opts: DreamOptions): Promise<DreamReport> {
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
    const pr = await passSpan(name, () => {
      switch (name) {
        case "expire":
          return expire(ctx);
        case "promote":
          return promote(ctx);
        case "dedupe":
          return dedupe(ctx, flaggedPairs);
        case "contradict":
          return contradict(ctx, flaggedPairs);
        case "reflect":
          return reflect(ctx);
        case "normalise":
          return normalise(ctx);
      }
    });
    // Occurrence retention runs with expiry, before reflect: an occurrence it tombstones is one
    // no current reflection rests on, and reflect then counts only what survives.
    if (name === "expire" && opts.config.occurrenceRetention) {
      // Set expire first so the report lists it ahead of retention.
      report.passes.expire = pr;
      report.passes.retention = await passSpan("retention", () => retain(ctx));
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
