import { matches } from "./filters.js";
import { tokenize } from "./tokens.js";
import type { Hit, IndexCapabilities, IndexedMemory, IndexQuery, MemoryIndex } from "./types.js";

/** In-process lexical index: term frequency scoring. For tests and tiny stores. */
export class InMemoryIndex implements MemoryIndex {
  readonly name = "memory";
  private readonly docs = new Map<string, IndexedMemory>();
  private readonly terms = new Map<string, Map<string, number>>();
  private revs: Record<string, string> = {};

  capabilities(): IndexCapabilities {
    return { lexical: true, semantic: false, graph: false };
  }
  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async rebuild(
    memories: Iterable<IndexedMemory>,
    revisions: Record<string, string>
  ): Promise<void> {
    this.docs.clear();
    this.terms.clear();
    await this.upsert([...memories]);
    this.revs = { ...revisions };
  }

  async upsert(memories: IndexedMemory[]): Promise<void> {
    for (const m of memories) {
      this.docs.set(m.memoryId, m);
      const tf = new Map<string, number>();
      for (const t of tokenize(`${m.summary} ${m.content} ${m.subject ?? ""} ${m.tags.join(" ")}`))
        tf.set(t, (tf.get(t) ?? 0) + 1);
      this.terms.set(m.memoryId, tf);
    }
  }

  async remove(memoryIds: string[]): Promise<void> {
    for (const id of memoryIds) {
      this.docs.delete(id);
      this.terms.delete(id);
    }
  }

  async search(q: IndexQuery): Promise<Hit[]> {
    const tokens = q.text ? tokenize(q.text) : [];
    const hits: Hit[] = [];
    for (const m of this.docs.values()) {
      if (!matches(m, q)) continue;
      if (tokens.length === 0) {
        hits.push({ memoryId: m.memoryId, relevance: 1, source: this.name });
        continue;
      }
      const tf = this.terms.get(m.memoryId);
      let score = 0;
      for (const t of tokens) score += tf?.get(t) ?? 0;
      if (score > 0) hits.push({ memoryId: m.memoryId, relevance: score, source: this.name });
    }
    if (tokens.length) {
      const max = Math.max(...hits.map((h) => h.relevance), 1);
      for (const h of hits) h.relevance = h.relevance / max;
      hits.sort((a, b) => b.relevance - a.relevance);
    } else {
      hits.sort((a, b) => (a.memoryId < b.memoryId ? 1 : -1));
    }
    return hits.slice(0, q.limit);
  }

  async get(memoryIds: string[]): Promise<Map<string, IndexedMemory>> {
    const out = new Map<string, IndexedMemory>();
    for (const id of memoryIds) {
      const m = this.docs.get(id);
      if (m) out.set(id, m);
    }
    return out;
  }

  async count(): Promise<number> {
    return this.docs.size;
  }
  async revisions(): Promise<Record<string, string>> {
    return { ...this.revs };
  }
  async setRevisions(revisions: Record<string, string>): Promise<void> {
    this.revs = { ...revisions };
  }
}
