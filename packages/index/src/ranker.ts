import type { MemoryType, ScoreExplain } from "@ynm/model";
import type { Hit, IndexedMemory, Ranked } from "./types.js";

/** Recency half-lives per type in days; undefined means no decay (ADR-005 decided). */
export const HALF_LIFE_DAYS: Record<MemoryType, number | undefined> = {
  working: 1,
  episodic: 14,
  reflective: 90,
  semantic: 180,
  procedural: undefined,
  reference: undefined,
};

export interface Weights {
  relevance: number;
  recency: number;
  importance: number;
  pinned: number;
}

/** With a text query relevance dominates; without one recency and importance carry the ranking. */
export const WEIGHTS_WITH_TEXT: Weights = {
  relevance: 0.6,
  recency: 0.2,
  importance: 0.15,
  pinned: 0.05,
};
export const WEIGHTS_FILTER_ONLY: Weights = {
  relevance: 0,
  recency: 0.55,
  importance: 0.35,
  pinned: 0.1,
};

export function recencyScore(type: MemoryType, updatedAt: string, now: Date): number {
  const half = HALF_LIFE_DAYS[type];
  if (half === undefined) return 1;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(updatedAt)) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / half);
}

/** Reciprocal rank fusion across several indexes' hit lists (k = 60, the usual constant). */
export function fuse(lists: Hit[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((h, i) => {
      fused.set(h.memoryId, (fused.get(h.memoryId) ?? 0) + 1 / (k + i + 1));
    });
  }
  return fused;
}

export interface RankOptions {
  hasText: boolean;
  now?: Date;
  weights?: Weights;
  explain?: boolean;
}

/**
 * score = w_rel * relevance + w_rec * recency(type) + w_imp * importance + w_pin * pinned.
 * Relevance comes from the fused hit lists (single list: the index's own 0..1 relevance).
 */
export function rank(
  lists: Hit[][],
  memories: Map<string, IndexedMemory>,
  opts: RankOptions
): Ranked[] {
  const weights = opts.weights ?? (opts.hasText ? WEIGHTS_WITH_TEXT : WEIGHTS_FILTER_ONLY);
  const now = opts.now ?? new Date();
  const relevanceById = new Map<string, number>();
  if (lists.length === 1) {
    for (const h of lists[0] ?? [])
      relevanceById.set(h.memoryId, Math.max(relevanceById.get(h.memoryId) ?? 0, h.relevance));
  } else {
    const fused = fuse(lists);
    const max = Math.max(...fused.values(), 1e-9);
    for (const [id, v] of fused) relevanceById.set(id, v / max);
  }
  const out: Ranked[] = [];
  for (const [memoryId, relevance] of relevanceById) {
    const m = memories.get(memoryId);
    if (!m) continue;
    const recency = recencyScore(m.type, m.updatedAt, now);
    const pinned = m.pinned ? 1 : 0;
    const total =
      weights.relevance * relevance +
      weights.recency * recency +
      weights.importance * m.importance +
      weights.pinned * pinned;
    const explain: ScoreExplain | undefined = opts.explain
      ? { relevance, recency, importance: m.importance, pinned, total, weights }
      : undefined;
    out.push({ memoryId, score: total, explain });
  }
  out.sort((a, b) => b.score - a.score || (a.memoryId < b.memoryId ? 1 : -1));
  return out;
}
