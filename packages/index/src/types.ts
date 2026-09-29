import type { Level, MemoryType, ScoreExplain } from "@ynm/model";
import type { Memory } from "@ynm/store";

export interface IndexQuery {
  text?: string;
  type?: MemoryType[];
  level?: Level[];
  namespace?: string;
  subject?: string;
  tags?: string[];
  dataKey?: string;
  since?: string;
  until?: string;
  pinnedOnly?: boolean;
  includeTombstoned?: boolean;
  /** Candidates to return before ranking; the service asks for more than the caller's limit. */
  limit: number;
}

export interface Hit {
  memoryId: string;
  /** 0..1, higher is better; 1 for pure filter queries. */
  relevance: number;
  /** Which index produced it. */
  source: string;
}

export interface IndexCapabilities {
  lexical: boolean;
  semantic: boolean;
  graph: boolean;
}

/** Indexed projection of a memory: enough to rank and render a hit without touching the log. */
export interface IndexedMemory {
  memoryId: string;
  mount: string;
  type: MemoryType;
  level: Level;
  namespace: string;
  subject?: string;
  tags: string[];
  dataKeys: string[];
  importance: number;
  confidence: number;
  pinned: boolean;
  needsReview: boolean;
  tombstoned: boolean;
  createdAt: string;
  updatedAt: string;
  versions: number;
  summary: string;
  content: string;
  /** The folded state, so a writer can apply its own new record exactly (ADR-005). */
  state?: Memory;
}

/**
 * The index seam (ADR-005). Derived, rebuildable, never the truth. Implementations are fed from
 * append results (upsert) and full scans (rebuild) and must never read the store themselves.
 */
export interface MemoryIndex {
  readonly name: string;
  capabilities(): IndexCapabilities;
  open(): Promise<void>;
  close(): Promise<void>;
  rebuild(memories: Iterable<IndexedMemory>, revisions: Record<string, string>): Promise<void>;
  upsert(memories: IndexedMemory[]): Promise<void>;
  remove(memoryIds: string[]): Promise<void>;
  search(q: IndexQuery): Promise<Hit[]>;
  get(memoryIds: string[]): Promise<Map<string, IndexedMemory>>;
  count(): Promise<number>;
  /** Shard revisions the index has seen, keyed by shard id; used for freshness checks. */
  revisions(): Promise<Record<string, string>>;
  setRevisions(revisions: Record<string, string>): Promise<void>;
}

export interface Ranked {
  memoryId: string;
  score: number;
  explain?: ScoreExplain;
}

export function toIndexed(mount: string, m: Memory): IndexedMemory {
  const cur = m.current;
  const dataText = cur.data
    ? Object.values(cur.data)
        .filter((v) => typeof v === "string")
        .join(" ")
    : "";
  return {
    memoryId: m.memoryId,
    mount,
    type: m.type,
    level: m.level,
    namespace: m.namespace,
    subject: m.subject,
    tags: m.tags,
    dataKeys: cur.data ? Object.keys(cur.data) : [],
    importance: m.importance,
    confidence: m.confidence,
    pinned: m.pinned,
    needsReview: m.needsReview,
    tombstoned: m.tombstoned,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    versions: m.versions,
    summary: cur.summary ?? "",
    content: `${cur.content ?? ""}${dataText ? `\n${dataText}` : ""}`,
    state: m,
  };
}
