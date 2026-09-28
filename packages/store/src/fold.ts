import type { Link, MemoryRecord } from "@ynm/model";

/** The current state of one memory, derived from its records. Never stored as truth (ADR-002). */
export interface Memory {
  memoryId: string;
  /** The latest create or supersede record; content, data and summary come from here. */
  current: MemoryRecord;
  type: MemoryRecord["type"];
  level: MemoryRecord["level"];
  namespace: string;
  subject?: string;
  tags: string[];
  links: Link[];
  importance: number;
  confidence: number;
  pinned: boolean;
  needsReview: boolean;
  tombstoned: boolean;
  tombstoneReason?: string;
  createdAt: string;
  updatedAt: string;
  /** Number of records folded into this memory. */
  versions: number;
}

export interface FoldResult {
  memories: Map<string, Memory>;
  /** Records whose memoryId never had a create or snapshot base; kept for diagnostics. */
  orphans: MemoryRecord[];
}

/** Deterministic order: recordedAt, then id, so replay is independent of shard order. */
export function compareRecords(a: MemoryRecord, b: MemoryRecord): number {
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function mergeLinks(existing: Link[], incoming: Link[]): Link[] {
  const seen = new Set(existing.map((l) => `${l.rel}:${l.to}`));
  const out = [...existing];
  for (const l of incoming) {
    const k = `${l.rel}:${l.to}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(l);
    }
  }
  return out;
}

function mergeTags(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  for (const t of incoming) if (!out.includes(t)) out.push(t);
  return out;
}

function fromBase(r: MemoryRecord): Memory {
  return {
    memoryId: r.memoryId,
    current: r,
    type: r.type,
    level: r.level,
    namespace: r.namespace,
    subject: r.subject,
    tags: [...r.tags],
    links: [...r.links],
    importance: r.importance ?? 0.5,
    confidence: r.confidence ?? 1,
    pinned: r.pinned ?? false,
    needsReview: r.needsReview ?? false,
    tombstoned: false,
    createdAt: r.recordedAt,
    updatedAt: r.recordedAt,
    versions: 1,
  };
}

function apply(m: Memory, r: MemoryRecord): void {
  m.versions += 1;
  m.updatedAt = r.recordedAt;
  switch (r.op) {
    case "supersede":
      m.current = r;
      m.type = r.type;
      m.namespace = r.namespace;
      m.subject = r.subject ?? m.subject;
      m.tags = mergeTags(m.tags, r.tags);
      m.links = mergeLinks(m.links, r.links);
      if (r.importance !== undefined) m.importance = r.importance;
      if (r.confidence !== undefined) m.confidence = r.confidence;
      if (r.pinned !== undefined) m.pinned = r.pinned;
      if (r.needsReview !== undefined) m.needsReview = r.needsReview;
      m.tombstoned = false;
      break;
    case "annotate":
      m.tags = mergeTags(m.tags, r.tags);
      m.links = mergeLinks(m.links, r.links);
      if (r.subject !== undefined) m.subject = r.subject;
      if (r.importance !== undefined) m.importance = r.importance;
      if (r.confidence !== undefined) m.confidence = r.confidence;
      if (r.pinned !== undefined) m.pinned = r.pinned;
      if (r.needsReview !== undefined) m.needsReview = r.needsReview;
      break;
    case "tombstone":
      m.tombstoned = true;
      m.tombstoneReason = r.reason;
      break;
    case "purge-marker":
      // Audit trail only; the purged lines are gone. State is unchanged.
      break;
    case "create":
      // A second create for the same memory is a merge artefact; the earlier one stays current
      // but the later one's tags and links are kept.
      m.tags = mergeTags(m.tags, r.tags);
      m.links = mergeLinks(m.links, r.links);
      break;
    case "snapshot":
      // Snapshots are handled by foldWithSnapshot; in a plain fold they carry no state change.
      break;
  }
}

/**
 * A record that arrived before its memory's base (create or supersede) is applied as "before":
 * it counts as a version and contributes tags and links, but the later base wins on any field it
 * sets, and a tombstone is only revived by a supersede, never by a create.
 */
function applyBefore(m: Memory, r: MemoryRecord): void {
  m.versions += 1;
  if (r.recordedAt < m.createdAt) m.createdAt = r.recordedAt;
  switch (r.op) {
    case "annotate":
    case "create":
      m.tags = mergeTags(r.tags, m.tags);
      m.links = mergeLinks(r.links, m.links);
      if (m.subject === undefined && r.subject !== undefined) m.subject = r.subject;
      if (m.current.importance === undefined && r.importance !== undefined)
        m.importance = r.importance;
      if (m.current.confidence === undefined && r.confidence !== undefined)
        m.confidence = r.confidence;
      if (m.current.pinned === undefined && r.pinned !== undefined) m.pinned = r.pinned;
      if (m.current.needsReview === undefined && r.needsReview !== undefined)
        m.needsReview = r.needsReview;
      break;
    case "tombstone":
      if (m.current.op !== "supersede") {
        m.tombstoned = true;
        m.tombstoneReason = r.reason;
      }
      break;
    default:
      break;
  }
}

function foldSorted(
  sorted: MemoryRecord[],
  memories: Map<string, Memory>,
  pending: Map<string, MemoryRecord[]>
): FoldResult {
  for (const r of sorted) {
    if (r.op === "snapshot") continue;
    const m = memories.get(r.memoryId);
    if (m) {
      apply(m, r);
      continue;
    }
    if (r.op === "create" || r.op === "supersede") {
      const base = fromBase(r);
      const late = pending.get(r.memoryId);
      if (late) {
        for (const p of late.sort(compareRecords)) applyBefore(base, p);
        pending.delete(r.memoryId);
      }
      memories.set(r.memoryId, base);
      continue;
    }
    const q = pending.get(r.memoryId);
    if (q) q.push(r);
    else pending.set(r.memoryId, [r]);
  }
  const orphans: MemoryRecord[] = [];
  for (const q of pending.values()) orphans.push(...q.sort(compareRecords));
  return { memories, orphans };
}

/**
 * Folds records into memories. Input order does not matter: records are sorted by
 * (recordedAt, id) first, which is what makes cat_sort_uniq reordering harmless.
 */
export function fold(records: Iterable<MemoryRecord>): FoldResult {
  return foldSorted([...records].sort(compareRecords), new Map(), new Map());
}

/** Snapshot payload shape stored in a snapshot record's data (ADR-002). */
export interface SnapshotData {
  memories: Memory[];
  /** Records still waiting for their base at snapshot time; carried so the fast path stays exact. */
  orphans?: MemoryRecord[];
  [key: string]: unknown;
}

/**
 * Folds from a snapshot plus the records recorded after it. Equivalent to folding everything,
 * which the semantics suite proves; this is the log-plus-checkpoint fast path (ADR-003).
 */
export function foldWithSnapshot(snapshot: MemoryRecord, tail: Iterable<MemoryRecord>): FoldResult {
  const data = snapshot.data as SnapshotData | undefined;
  const memories = new Map<string, Memory>();
  for (const m of data?.memories ?? []) memories.set(m.memoryId, structuredClone(m));
  const pending = new Map<string, MemoryRecord[]>();
  for (const o of data?.orphans ?? []) {
    const q = pending.get(o.memoryId);
    if (q) q.push(o);
    else pending.set(o.memoryId, [o]);
  }
  const later = [...tail].filter((r) => compareRecords(r, snapshot) > 0).sort(compareRecords);
  return foldSorted(later, memories, pending);
}

/** Builds the snapshot record's payload from a fold. */
export function snapshotData(result: FoldResult): SnapshotData {
  return { memories: [...result.memories.values()], orphans: result.orphans };
}
