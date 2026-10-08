import { OCCURRENCE_TAG } from "@ynm/model";
import { z } from "zod";
import { durationMs } from "../lifecycle.js";
import type { MemoryWithMount } from "../ynm.js";
import {
  PAIR_QUESTIONS,
  PROMOTE_QUESTIONS,
  SUPERSEDE_QUESTION,
  VERIFY_QUESTIONS,
} from "./questions.js";
import {
  addUsage,
  band,
  type DreamContext,
  emptyReport,
  noteJudge,
  type PassReport,
  storedJudgment,
} from "./types.js";

function brief(m: MemoryWithMount) {
  return {
    summary: m.current.summary ?? "",
    content: (m.current.content ?? "").slice(0, 2000),
    type: m.type,
    namespace: m.namespace,
    subject: m.subject ?? null,
    updatedAt: m.updatedAt,
  };
}

/**
 * A memory its writer marked as one occurrence of an event: dedupe and contradiction leave it
 * alone, on either side of a pair, so repeats survive for reflection to count.
 */
function isOccurrence(m: MemoryWithMount): boolean {
  return m.tags.includes(OCCURRENCE_TAG);
}

async function flag(
  ctx: DreamContext,
  ids: string[],
  data: Record<string, unknown>,
  reason: string
): Promise<void> {
  if (ctx.dryRun) return;
  for (const memoryId of ids) await ctx.ynm.annotate({ memoryId, needsReview: true, reason, data });
}

/** Pass 1: tombstone working memory past its ttl. No model. */
export async function expire(ctx: DreamContext): Promise<PassReport> {
  const r = emptyReport();
  const now = ctx.now().getTime();
  for (const m of await ctx.ynm.list({
    type: "working",
    namespace: ctx.namespace,
    includeTombstoned: false,
  })) {
    if (!m.current.ttl) continue;
    r.candidates += 1;
    if (Date.parse(m.updatedAt) + durationMs(m.current.ttl) <= now) {
      if (!ctx.dryRun) await ctx.ynm.forget({ memoryId: m.memoryId, reason: "expired" });
      r.changed.push(m.memoryId);
    }
  }
  return r;
}

/**
 * Pass 1, second half: occurrence retention. Memories tagged `occurrence` are never merged, so
 * without a window they accumulate forever. One unchanged for longer than
 * `occurrenceRetention` is tombstoned, unless the newest live reflective memory on its subject
 * links to it: a reflection always keeps its evidence. No model. Reported apart from TTL expiry.
 */
export async function retain(ctx: DreamContext): Promise<PassReport> {
  const r = emptyReport();
  const window = ctx.config.occurrenceRetention;
  if (!window) return r;
  const cutoff = ctx.now().getTime() - durationMs(window);
  const live = await ctx.ynm.list({ includeTombstoned: false });
  // The newest reflection per subject, from any namespace: it is written where its first
  // episode lives, which a namespace-scoped run need not include.
  const newest = new Map<string, MemoryWithMount>();
  for (const m of live) {
    if (m.type !== "reflective" || !m.subject) continue;
    const key = `${m.mount}:${m.subject}`;
    const prior = newest.get(key);
    if (!prior || m.updatedAt > prior.updatedAt) newest.set(key, m);
  }
  const evidence = new Set([...newest.values()].flatMap((m) => m.links.map((l) => l.to)));
  const occurrences = ctx.namespace
    ? await ctx.ynm.list({ namespace: ctx.namespace, includeTombstoned: false })
    : live;
  let kept = 0;
  for (const m of occurrences) {
    if (!isOccurrence(m)) continue;
    r.candidates += 1;
    if (Date.parse(m.updatedAt) > cutoff) continue;
    if (evidence.has(m.memoryId)) {
      kept += 1;
      continue;
    }
    if (!ctx.dryRun)
      await ctx.ynm.forget({ memoryId: m.memoryId, reason: `occurrence retention (${window})` });
    r.changed.push(m.memoryId);
  }
  if (kept) r.notes.push(`kept ${kept} past retention as evidence for a reflection`);
  return r;
}

/**
 * Pass 2: working memory that should outlive the session. An explicit `promote` tag acts without
 * a model; otherwise the judge decides and only a calibrated judge may act. Only fresh memories
 * are judged; a tagged one is promoted whenever it is seen.
 */
export async function promote(ctx: DreamContext): Promise<PassReport> {
  const r = emptyReport();
  const at = ctx.now().toISOString();
  const working = await ctx.ynm.list({
    type: "working",
    namespace: ctx.namespace,
    includeTombstoned: false,
  });
  for (const m of byOwner(ctx, working, (w) => w.memoryId)) {
    if (!ctx.fresh.has(m.memoryId) && !m.tags.includes("promote")) continue;
    r.candidates += 1;
    let target: "semantic" | "episodic" | "procedural" | "reference" = "episodic";
    let decision: "act" | "review" | "ignore";
    let judgmentData: Record<string, unknown> | undefined;
    if (m.tags.includes("promote")) decision = "act";
    else {
      if (!ctx.judging) continue;
      if (ctx.pairsJudged.n >= ctx.maxPairs) {
        r.skipped += 1;
        ctx.deferred.add(m.memoryId);
        continue;
      }
      const j = await ctx.judge.judge({ memory: brief(m) }, PROMOTE_QUESTIONS);
      ctx.pairsJudged.n += 1;
      r.judged += 1;
      addUsage(r.usage, j.usage);
      const p = (j.answers.usefulLater as { noul: number }).noul;
      decision = band(p, ctx.config.thresholds.promote, j.calibrated);
      const kind = (j.answers.kind as { choice: string }).choice;
      if (kind === "semantic" || kind === "procedural" || kind === "reference") target = kind;
      noteJudge(r, ctx, j);
      judgmentData = { judgments: [storedJudgment("promote", j, PROMOTE_QUESTIONS, at, decision)] };
    }
    if (decision === "act") {
      if (!ctx.dryRun) {
        const namespace = ctx.ynm.defaultNamespace(m.level);
        const created = await ctx.ynm.remember({
          type: target,
          level: m.level,
          namespace,
          content: m.current.content ?? "",
          summary: m.current.summary,
          subject: m.subject,
          tags: m.tags.filter((t) => t !== "promote"),
          importance: m.importance,
          links: [{ rel: "derives-from", to: m.memoryId }],
        });
        await ctx.ynm.forget({ memoryId: m.memoryId, reason: `promoted to ${created.memoryId}` });
        if (judgmentData)
          await ctx.ynm.annotate({
            memoryId: created.memoryId,
            data: judgmentData,
            reason: "promotion judgment",
          });
      }
      r.changed.push(m.memoryId);
    } else if (decision === "review") {
      await flag(ctx, [m.memoryId], judgmentData ?? {}, "promotion needs review");
      r.flagged.push(m.memoryId);
    }
  }
  return r;
}

/**
 * Every pass works through fresh memories in the run's one working order (newest first), so under
 * the pair cap they all finish the same leading memories and each run shrinks the backlog. The
 * sort is stable: items of one owner keep their order (a memory's nearest neighbours first).
 */
function byOwner<T>(ctx: DreamContext, items: T[], owner: (t: T) => string): T[] {
  const at = (t: T) => ctx.order.get(owner(t)) ?? Number.POSITIVE_INFINITY;
  return [...items].sort(
    (x, y) => at(x) - at(y) || (owner(x) < owner(y) ? -1 : owner(x) > owner(y) ? 1 : 0)
  );
}

interface Pair {
  /** The older memory. */
  a: MemoryWithMount;
  /** The newer memory. */
  b: MemoryWithMount;
  /**
   * The fresh memory this pair is judged for: of two fresh sides, the one first in the working
   * order, so the pair is judged at the earlier of their two turns. A pair the cap defers keeps
   * only its owner fresh, and pairs come grouped by owner, so every run finishes whole memories
   * and the backlog shrinks.
   */
  owner: string;
}

/**
 * Candidate pairs from the index: each fresh memory's nearest neighbours of the same type and
 * mount. A pair of two memories already dreamed was judged by an earlier run. Occurrences are
 * never owners or neighbours.
 */
async function candidatePairs(
  ctx: DreamContext,
  types: Array<MemoryWithMount["type"]>
): Promise<Pair[]> {
  const memories = (
    await ctx.ynm.list({ namespace: ctx.namespace, includeTombstoned: false })
  ).filter((m) => types.includes(m.type) && !isOccurrence(m));
  // Recall hits can include occurrences; looking them up here drops them.
  const byId = new Map(memories.map((m) => [m.memoryId, m]));
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  // Walk owners in the order they are judged, so a pair goes to the side whose turn comes first.
  for (const m of byOwner(ctx, memories, (x) => x.memoryId)) {
    if (!ctx.fresh.has(m.memoryId)) continue;
    const text = `${m.current.summary ?? ""} ${(m.current.content ?? "").slice(0, 400)}`;
    const hits = await ctx.ynm.recall({
      text,
      type: [m.type],
      namespace: ctx.namespace,
      mount: m.mount,
      rerank: false, // candidates come from the index only; the judge sees pairs, not queries
      // No more neighbours than one run can judge, so a memory can always be finished.
      limit: Math.min(ctx.config.candidatesPerMemory, ctx.maxPairs) + 1,
    });
    for (const h of hits) {
      if (h.memoryId === m.memoryId) continue;
      const other = byId.get(h.memoryId);
      if (!other) continue;
      const key = [m.memoryId, h.memoryId].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b] = m.updatedAt <= other.updatedAt ? [m, other] : [other, m];
      pairs.push({ a, b, owner: m.memoryId });
    }
  }
  return pairs;
}

const MergedSchema = z.object({ content: z.string().min(1), summary: z.string().min(1).max(280) });

/** Pass 3: duplicates. Survivor is the newer memory; the older is tombstoned and linked. */
export async function dedupe(ctx: DreamContext, pairsOut?: Pair[]): Promise<PassReport> {
  const r = emptyReport();
  const at = ctx.now().toISOString();
  const pairs = await candidatePairs(ctx, [
    "semantic",
    "procedural",
    "episodic",
    "reference",
    "reflective",
  ]);
  r.candidates = pairs.length;
  if (!ctx.judging) return r;
  for (const { a, b, owner } of pairs) {
    if (ctx.pairsJudged.n >= ctx.maxPairs) {
      r.skipped += 1;
      ctx.deferred.add(owner);
      continue;
    }
    const j = await ctx.judge.judge({ a: brief(a), b: brief(b) }, PAIR_QUESTIONS);
    ctx.pairsJudged.n += 1;
    r.judged += 1;
    addUsage(r.usage, j.usage);
    noteJudge(r, ctx, j);
    const same = (j.answers.sameFact as { noul: number }).noul;
    const contradicts = (j.answers.contradicts as { noul: number }).noul;
    if (contradicts >= ctx.config.thresholds.contradict.review) pairsOut?.push({ a, b, owner });
    const decision = band(same, ctx.config.thresholds.dedupe, j.calibrated);
    const data = {
      judgments: [storedJudgment("dedupe", j, PAIR_QUESTIONS, at, decision)],
      pair: [a.memoryId, b.memoryId],
    };
    if (decision === "act") {
      if (!ctx.dryRun) {
        let merged: { content: string; summary: string } | undefined;
        if (ctx.writer.name !== "none") {
          try {
            const w = await ctx.writer.write({
              instructions:
                "Merge these two memories that state the same fact into one. Keep every material detail, drop repetition, prefer the newer phrasing where they differ. Return the merged markdown content and a one-line summary.",
              state: { older: brief(a), newer: brief(b) },
              schema: MergedSchema,
              schemaName: "merged_memory",
            });
            merged = w.value;
            addUsage(r.usage, w.usage);
          } catch (e) {
            r.notes.push(`merge text fallback for ${b.memoryId}: ${(e as Error).message}`);
            r.fallback = true;
          }
        } else r.fallback = true;
        if (merged)
          await ctx.ynm.supersede({
            memoryId: b.memoryId,
            content: merged.content,
            summary: merged.summary,
            tags: a.tags,
            links: [{ rel: "derives-from", to: a.memoryId }],
          });
        else
          await ctx.ynm.annotate({
            memoryId: b.memoryId,
            links: [{ rel: "derives-from", to: a.memoryId }],
            tags: a.tags,
            data,
            reason: "duplicate merged",
          });
        await ctx.ynm.forget({ memoryId: a.memoryId, reason: `duplicate of ${b.memoryId}` });
      }
      r.changed.push(a.memoryId);
    } else if (decision === "review") {
      await flag(ctx, [a.memoryId, b.memoryId], data, "possible duplicate");
      r.flagged.push(a.memoryId, b.memoryId);
    }
  }
  return r;
}

/**
 * Pass 4: contradictions among memories sharing a subject (plus pairs dedupe flagged), for pairs
 * with at least one fresh side. A fresh memory owns its pairs with every peer except fresh ones
 * ahead of it in the working order (they own those), up to the newest peers one run can judge.
 * Occurrences are left out on both sides.
 */
export async function contradict(ctx: DreamContext, extra: Pair[] = []): Promise<PassReport> {
  const r = emptyReport();
  const at = ctx.now().toISOString();
  const memories = (
    await ctx.ynm.list({ namespace: ctx.namespace, includeTombstoned: false })
  ).filter((m) => m.subject && m.type !== "working" && !isOccurrence(m));
  const bySubject = new Map<string, MemoryWithMount[]>();
  for (const m of memories) {
    const list = bySubject.get(`${m.mount}:${m.subject}`) ?? [];
    list.push(m);
    bySubject.set(`${m.mount}:${m.subject}`, list);
  }
  const pairs: Pair[] = extra.filter((p) => !isOccurrence(p.a) && !isOccurrence(p.b));
  const seen = new Set(pairs.map((p) => [p.a.memoryId, p.b.memoryId].sort().join(":")));
  for (const list of bySubject.values()) {
    const sorted = byOwner(ctx, list, (m) => m.memoryId);
    sorted.forEach((owner, i) => {
      if (!ctx.fresh.has(owner.memoryId)) return;
      const peers = sorted
        .filter((p, k) => k !== i && (k > i || !ctx.fresh.has(p.memoryId)))
        .slice(0, ctx.maxPairs);
      for (const peer of peers) {
        const key = [owner.memoryId, peer.memoryId].sort().join(":");
        if (seen.has(key)) continue;
        seen.add(key);
        const [a, b] = peer.updatedAt <= owner.updatedAt ? [peer, owner] : [owner, peer];
        pairs.push({ a, b, owner: owner.memoryId });
      }
    });
  }
  r.candidates = pairs.length;
  if (!ctx.judging) return r;
  for (const { a, b, owner } of byOwner(ctx, pairs, (p) => p.owner)) {
    if (ctx.pairsJudged.n >= ctx.maxPairs) {
      r.skipped += 1;
      ctx.deferred.add(owner);
      continue;
    }
    const questions = { contradicts: PAIR_QUESTIONS.contradicts, ...SUPERSEDE_QUESTION };
    const j = await ctx.judge.judge({ a: brief(a), b: brief(b) }, questions);
    ctx.pairsJudged.n += 1;
    r.judged += 1;
    addUsage(r.usage, j.usage);
    noteJudge(r, ctx, j);
    const c = (j.answers.contradicts as { noul: number }).noul;
    const decision = band(c, ctx.config.thresholds.contradict, j.calibrated);
    if (decision === "ignore") continue;
    const supersedes = (j.answers.newerSupersedes as { noul: number }).noul;
    const data = {
      judgments: [storedJudgment("contradict", j, questions, at, decision)],
      pair: [a.memoryId, b.memoryId],
    };
    if (!ctx.dryRun) {
      await ctx.ynm.annotate({
        memoryId: b.memoryId,
        links: [{ rel: "contradicts", to: a.memoryId }],
        data,
        reason: "contradiction",
      });
      await ctx.ynm.annotate({
        memoryId: a.memoryId,
        links: [{ rel: "contradicts", to: b.memoryId }],
        reason: "contradiction",
      });
    }
    if (decision === "act" && supersedes >= ctx.config.thresholds.contradict.act) {
      if (!ctx.dryRun)
        await ctx.ynm.forget({
          memoryId: a.memoryId,
          reason: `superseded by ${b.memoryId} (contradiction resolved)`,
        });
      r.changed.push(a.memoryId);
    } else {
      await flag(ctx, [a.memoryId, b.memoryId], {}, "contradiction needs review");
      r.flagged.push(a.memoryId, b.memoryId);
    }
  }
  return r;
}

const ReflectionSchema = z.object({
  summary: z.string().min(1).max(280),
  content: z.string().min(1),
});

/**
 * Pass 5: one reflective memory per subject with enough episodes, verified before it is written.
 * A subject is reflected on again only when one of its episodes is fresh. Occurrences count as
 * episodes like any other; the reflection does not inherit their occurrence tag. It links the
 * episodes it was written from, the newest twelve.
 */
export async function reflect(ctx: DreamContext): Promise<PassReport> {
  const r = emptyReport();
  const at = ctx.now().toISOString();
  const all = await ctx.ynm.list({ namespace: ctx.namespace, includeTombstoned: false });
  const episodes = new Map<string, MemoryWithMount[]>();
  const reflections = new Map<string, MemoryWithMount>();
  for (const m of all) {
    if (!m.subject) continue;
    const key = `${m.mount}:${m.subject}`;
    if (m.type === "episodic") episodes.set(key, [...(episodes.get(key) ?? []), m]);
    if (m.type === "reflective") reflections.set(key, m);
  }
  for (const [key, list] of episodes) {
    if (list.length < ctx.config.thresholds.reflect.minEpisodes) continue;
    if (!list.some((m) => ctx.fresh.has(m.memoryId))) continue;
    const latest = list.reduce((x, y) => (x.updatedAt > y.updatedAt ? x : y));
    const existing = reflections.get(key);
    if (existing && existing.updatedAt >= latest.updatedAt) continue;
    r.candidates += 1;
    if (!ctx.judging) continue;
    if (ctx.writer.name === "none") {
      r.skipped += 1;
      r.fallback = true;
      continue;
    }
    // The newest episodes are what the reflection is written from, and all it links to: its
    // evidence, which occurrence retention keeps. Older ones it never saw are free to expire.
    const evidence = list.sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : 1)).slice(-12);
    const sample = evidence.map((m) => ({
      date: m.updatedAt.slice(0, 10),
      summary: m.current.summary ?? "",
      content: (m.current.content ?? "").slice(0, 800),
    }));
    const subject = list[0]?.subject as string;
    let written: { summary: string; content: string };
    try {
      const w = await ctx.writer.write({
        instructions: `Write a reflective memory about ${subject} that summarises what these episodes state. Report only facts, dates and outcomes that appear in the episodes; you may note that a cause or outcome repeats, but do not add causes, recommendations, or claims the episodes do not contain. Keep dates absolute.`,
        state: { subject, episodes: sample },
        schema: ReflectionSchema,
        schemaName: "reflection",
      });
      written = w.value;
      addUsage(r.usage, w.usage);
    } catch (e) {
      r.notes.push(`reflect skipped ${subject}: ${(e as Error).message}`);
      r.skipped += 1;
      r.fallback = true;
      continue;
    }
    const sources = sample.map((s) => `[${s.date}] ${s.summary}: ${s.content}`).join("\n");
    const j = await ctx.judge.judge({ summary: written.content, sources }, VERIFY_QUESTIONS);
    r.judged += 1;
    addUsage(r.usage, j.usage);
    noteJudge(r, ctx, j);
    const flags = Object.entries(j.answers)
      .filter(([, a]) => (a as { noul: number }).noul >= ctx.config.thresholds.reflect.flagAt)
      .map(([k]) => k);
    r.notes.push(
      `verify ${subject}: ${Object.entries(j.answers)
        .map(([k, a]) => `${k}=${(a as { noul: number }).noul.toFixed(2)}`)
        .join(" ")}`
    );
    const data = {
      judgments: [
        storedJudgment("reflect", j, VERIFY_QUESTIONS, at, flags.length ? "review" : "act"),
      ],
    };
    if (flags.length) {
      r.flagged.push(...list.map((m) => m.memoryId));
      r.notes.push(`reflection for ${subject} not written: ${flags.join(", ")} flagged`);
      continue;
    }
    if (!ctx.dryRun) {
      const first = list[0] as MemoryWithMount;
      const created = await ctx.ynm.remember(
        {
          type: "reflective",
          level: first.level,
          namespace: first.namespace,
          subject,
          content: written.content,
          summary: written.summary,
          tags: [...new Set(list.flatMap((m) => m.tags))].filter((t) => t !== OCCURRENCE_TAG),
          links: evidence.map((m) => ({ rel: "derives-from" as const, to: m.memoryId })),
        },
        first.mount
      );
      await ctx.ynm.annotate({ memoryId: created.memoryId, data, reason: "reflection verified" });
      if (existing)
        await ctx.ynm.forget({
          memoryId: existing.memoryId,
          reason: `replaced by ${created.memoryId}`,
        });
    }
    r.changed.push(key);
  }
  return r;
}

const RELATIVE =
  /\b(today|yesterday|tomorrow|last week|next week|this week|last month|next month|(\d+) days? ago)\b/gi;

export function absolutise(text: string, recordedAt: string): string {
  const base = new Date(recordedAt);
  const day = (offset: number) =>
    new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return text.replace(RELATIVE, (m, _w, n) => {
    const l = m.toLowerCase();
    if (l === "today") return day(0);
    if (l === "yesterday") return day(-1);
    if (l === "tomorrow") return day(1);
    if (l === "last week") return `the week of ${day(-7)}`;
    if (l === "next week") return `the week of ${day(7)}`;
    if (l === "this week") return `the week of ${day(0)}`;
    if (l === "last month") return `around ${day(-30)}`;
    if (l === "next month") return `around ${day(30)}`;
    if (n) return day(-Number(n));
    return m;
  });
}

/** Pass 6: relative dates in fresh memories become absolute (no model). */
export async function normalise(ctx: DreamContext): Promise<PassReport> {
  const r = emptyReport();
  for (const m of await ctx.ynm.list({ namespace: ctx.namespace, includeTombstoned: false })) {
    if (!ctx.fresh.has(m.memoryId)) continue;
    const content = m.current.content ?? "";
    if (!RELATIVE.test(content)) {
      RELATIVE.lastIndex = 0;
      continue;
    }
    RELATIVE.lastIndex = 0;
    r.candidates += 1;
    const fixed = absolutise(content, m.current.recordedAt);
    if (fixed === content) continue;
    if (!ctx.dryRun)
      await ctx.ynm.supersede({
        memoryId: m.memoryId,
        content: fixed,
        summary: m.current.summary,
        tags: [],
        links: [],
      });
    r.changed.push(m.memoryId);
  }
  return r;
}
