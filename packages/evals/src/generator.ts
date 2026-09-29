import type { MemoryRecord, MemoryType } from "@ynm/model";
import { MEMORY_TYPES, ulid } from "@ynm/model";

/** mulberry32: small, seedable, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "anchor root commit shard bucket fold record memory notes merge sync clone remote branch index recall context dream judge writer wiki agent session release deploy lint test coverage schema zod oclif mcp transport stdio http auth token docker".split(
    " "
  );

export interface GeneratedCorpus {
  records: MemoryRecord[];
  /** Pairs of memoryIds that are near-duplicates by construction. */
  duplicates: Array<[string, string]>;
  /** Pairs of memoryIds that contradict by construction (same subject, negated claim). */
  contradictions: Array<[string, string]>;
  /** Queries with the memoryIds that should rank for them. */
  queries: Array<{ text: string; relevant: string[] }>;
}

export interface GenerateOptions {
  seed?: number;
  count: number;
  level?: "personal" | "distributed";
  namespaces?: string[];
  types?: readonly MemoryType[];
  /** yyyy-mm buckets to spread records over. */
  months?: string[];
  duplicateRate?: number;
  contradictionRate?: number;
}

/**
 * Deterministic synthetic corpus (ADR-014): records with known duplicates, contradictions,
 * subjects and query relevance, sized for 1k, 10k and 100k runs.
 */
export function generateCorpus(opts: GenerateOptions): GeneratedCorpus {
  const r = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const level = opts.level ?? "personal";
  const namespaces =
    opts.namespaces ??
    (level === "personal" ? ["user/test"] : ["common", "org/eyelock/project/ynm"]);
  const types = (opts.types ??
    MEMORY_TYPES.filter((t) => t !== "working")) as readonly MemoryType[];
  const months = opts.months ?? ["2026-06", "2026-07", "2026-08", "2026-09"];
  const dupRate = opts.duplicateRate ?? 0.05;
  const conRate = opts.contradictionRate ?? 0.02;
  const records: MemoryRecord[] = [];
  const duplicates: GeneratedCorpus["duplicates"] = [];
  const contradictions: GeneratedCorpus["contradictions"] = [];
  const bySubject = new Map<string, string[]>();
  let t = Date.parse("2026-06-01T00:00:00.000Z");

  const sentence = (k: number): string => Array.from({ length: k }, () => pick(WORDS)).join(" ");
  const make = (
    content: string,
    subject: string,
    type: MemoryType,
    memoryId?: string
  ): MemoryRecord => {
    t += 1000 + Math.floor(r() * 5000);
    const month = pick(months);
    const day = 1 + Math.floor(r() * 27);
    const recordedAt = `${month}-${String(day).padStart(2, "0")}T${new Date(t).toISOString().slice(11)}`;
    const id = ulid(Date.parse(recordedAt) + Math.floor(r() * 1000), r);
    return {
      v: 1,
      id,
      memoryId: memoryId ?? id,
      op: "create",
      type,
      level,
      namespace: pick(namespaces),
      subject,
      tags: [pick(WORDS), pick(WORDS)],
      content,
      summary: content.slice(0, 80),
      importance: Math.round(r() * 100) / 100,
      confidence: 1,
      recordedAt,
      provenance: { actor: "generator", session: `s${Math.floor(r() * 50)}` },
      links: [],
    };
  };

  for (let i = 0; i < opts.count; i++) {
    const subject = `topic:${pick(WORDS)}-${Math.floor(r() * 40)}`;
    const type = pick(types);
    const claim = `${sentence(6)} is ${pick(["true", "required", "fast", "stable"])} for ${subject.slice(6)}`;
    const rec = make(`${claim}. ${sentence(10)}.`, subject, type);
    records.push(rec);
    const list = bySubject.get(subject) ?? [];
    list.push(rec.memoryId);
    bySubject.set(subject, list);
    if (r() < dupRate) {
      const dup = make(`${claim}. ${sentence(3)}.`, subject, type);
      records.push(dup);
      duplicates.push([rec.memoryId, dup.memoryId]);
      i += 1;
    } else if (r() < conRate) {
      const con = make(`${claim.replace(/ is /, " is not ")}. ${sentence(8)}.`, subject, type);
      records.push(con);
      contradictions.push([rec.memoryId, con.memoryId]);
      i += 1;
    }
  }
  const queries: GeneratedCorpus["queries"] = [];
  for (const [subject, ids] of bySubject) {
    if (queries.length >= 50) break;
    if (ids.length >= 2) queries.push({ text: subject.slice(6), relevant: ids });
  }
  return { records: records.slice(0, opts.count), duplicates, contradictions, queries };
}
