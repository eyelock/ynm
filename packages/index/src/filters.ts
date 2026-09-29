import type { IndexedMemory, IndexQuery } from "./types.js";

/** Whole-segment namespace prefix match, shared with the store. */
export function namespaceMatches(namespace: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  return namespace === prefix || namespace.startsWith(`${prefix}/`);
}

/** Pure filter used by the memory index and by the SQLite index's tests. */
export function matches(m: IndexedMemory, q: IndexQuery): boolean {
  if (!q.includeTombstoned && m.tombstoned) return false;
  if (q.type?.length && !q.type.includes(m.type)) return false;
  if (q.level?.length && !q.level.includes(m.level)) return false;
  if (!namespaceMatches(m.namespace, q.namespace)) return false;
  if (q.subject && m.subject !== q.subject) return false;
  if (q.tags?.length && !q.tags.every((t) => m.tags.includes(t))) return false;
  if (q.dataKey && !m.dataKeys.includes(q.dataKey)) return false;
  if (q.since && m.updatedAt < q.since) return false;
  if (q.until && m.updatedAt > q.until) return false;
  if (q.pinnedOnly && !m.pinned) return false;
  return true;
}
