import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tokenize } from "./tokens.js";
import type { Hit, IndexCapabilities, IndexedMemory, IndexQuery, MemoryIndex } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revisions (shard TEXT PRIMARY KEY, revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  memoryId TEXT PRIMARY KEY, mount TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL,
  namespace TEXT NOT NULL, subject TEXT, tags TEXT NOT NULL, dataKeys TEXT NOT NULL,
  importance REAL NOT NULL, confidence REAL NOT NULL, pinned INTEGER NOT NULL, needsReview INTEGER NOT NULL,
  tombstoned INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, versions INTEGER NOT NULL,
  summary TEXT NOT NULL, content TEXT NOT NULL, state TEXT
);
CREATE INDEX IF NOT EXISTS memories_ns ON memories(namespace);
CREATE INDEX IF NOT EXISTS memories_updated ON memories(updatedAt);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(memoryId UNINDEXED, summary, content, subject, tags, tokenize = 'porter unicode61');
`;

type Row = Record<string, string | number | null>;

function rowToMemory(r: Row): IndexedMemory {
  return {
    memoryId: r.memoryId as string,
    mount: r.mount as string,
    type: r.type as IndexedMemory["type"],
    level: r.level as IndexedMemory["level"],
    namespace: r.namespace as string,
    subject: (r.subject as string | null) ?? undefined,
    tags: JSON.parse(r.tags as string) as string[],
    dataKeys: JSON.parse(r.dataKeys as string) as string[],
    importance: r.importance as number,
    confidence: r.confidence as number,
    pinned: r.pinned === 1,
    needsReview: r.needsReview === 1,
    tombstoned: r.tombstoned === 1,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
    versions: r.versions as number,
    summary: r.summary as string,
    content: r.content as string,
    state: r.state ? (JSON.parse(r.state as string) as IndexedMemory["state"]) : undefined,
  };
}

/** FTS5 query: quoted tokens OR'd, so any matching term ranks; bm25 orders the rest. */
export function ftsQuery(text: string): string | null {
  const tokens = tokenize(text).map((t) => `"${t.replace(/"/g, "")}"`);
  return tokens.length ? tokens.join(" OR ") : null;
}

/**
 * Default index (ADR-005): one file, BM25 ranking through FTS5, metadata filters in the same
 * query. Uses node:sqlite, so no native module (Node 22.13+).
 */
export class SqliteIndex implements MemoryIndex {
  readonly name = "sqlite-fts";
  private db: DatabaseSync | null = null;

  constructor(readonly file: string) {}

  capabilities(): IndexCapabilities {
    return { lexical: true, semantic: false, graph: false };
  }

  private conn(): DatabaseSync {
    if (!this.db) throw new Error("index not open");
    return this.db;
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (this.file !== ":memory:") mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async rebuild(
    memories: Iterable<IndexedMemory>,
    revisions: Record<string, string>
  ): Promise<void> {
    const db = this.conn();
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM memories; DELETE FROM fts; DELETE FROM revisions;");
      this.write([...memories], true);
      this.writeRevisions(revisions);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * FTS rows share the memories table's rowid so replacing or removing a memory is an indexed
   * lookup, not a scan of the FTS table (memoryId is UNINDEXED there). `fresh` skips the lookup
   * during a rebuild of emptied tables.
   */
  private write(memories: IndexedMemory[], fresh = false): void {
    const db = this.conn();
    const findRow = db.prepare("SELECT rowid FROM memories WHERE memoryId = ?");
    const delFts = db.prepare("DELETE FROM fts WHERE rowid = ?");
    const ins = db.prepare(
      `INSERT OR REPLACE INTO memories (memoryId, mount, type, level, namespace, subject, tags, dataKeys, importance, confidence, pinned, needsReview, tombstoned, createdAt, updatedAt, versions, summary, content, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const fts = db.prepare(
      "INSERT INTO fts (rowid, memoryId, summary, content, subject, tags) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const m of memories) {
      if (!fresh) {
        const row = findRow.get(m.memoryId) as { rowid: number } | undefined;
        if (row) delFts.run(row.rowid);
      }
      const result = ins.run(
        m.memoryId,
        m.mount,
        m.type,
        m.level,
        m.namespace,
        m.subject ?? null,
        JSON.stringify(m.tags),
        JSON.stringify(m.dataKeys),
        m.importance,
        m.confidence,
        m.pinned ? 1 : 0,
        m.needsReview ? 1 : 0,
        m.tombstoned ? 1 : 0,
        m.createdAt,
        m.updatedAt,
        m.versions,
        m.summary,
        m.content,
        m.state ? JSON.stringify(m.state) : null
      );
      fts.run(
        Number(result.lastInsertRowid),
        m.memoryId,
        m.summary,
        m.content,
        m.subject ?? "",
        m.tags.join(" ")
      );
    }
  }

  async upsert(memories: IndexedMemory[]): Promise<void> {
    if (memories.length === 0) return;
    const db = this.conn();
    db.exec("BEGIN");
    try {
      this.write(memories);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  async remove(memoryIds: string[]): Promise<void> {
    const db = this.conn();
    const findRow = db.prepare("SELECT rowid FROM memories WHERE memoryId = ?");
    const delFts = db.prepare("DELETE FROM fts WHERE rowid = ?");
    const delMem = db.prepare("DELETE FROM memories WHERE memoryId = ?");
    for (const id of memoryIds) {
      const row = findRow.get(id) as { rowid: number } | undefined;
      if (row) delFts.run(row.rowid);
      delMem.run(id);
    }
  }

  private where(q: IndexQuery, params: Array<string | number>): string {
    const clauses: string[] = [];
    if (!q.includeTombstoned) clauses.push("m.tombstoned = 0");
    if (q.type?.length) {
      clauses.push(`m.type IN (${q.type.map(() => "?").join(",")})`);
      params.push(...q.type);
    }
    if (q.level?.length) {
      clauses.push(`m.level IN (${q.level.map(() => "?").join(",")})`);
      params.push(...q.level);
    }
    if (q.namespace) {
      clauses.push("(m.namespace = ? OR m.namespace LIKE ?)");
      params.push(q.namespace, `${q.namespace.replace(/[%_]/g, "\\$&")}/%`);
    }
    if (q.subject) {
      clauses.push("m.subject = ?");
      params.push(q.subject);
    }
    for (const t of q.tags ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)");
      params.push(t);
    }
    for (const t of q.excludeTags ?? []) {
      clauses.push("NOT EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)");
      params.push(t);
    }
    if (q.dataKey) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(m.dataKeys) WHERE value = ?)");
      params.push(q.dataKey);
    }
    if (q.since) {
      clauses.push("m.updatedAt >= ?");
      params.push(q.since);
    }
    if (q.until) {
      clauses.push("m.updatedAt <= ?");
      params.push(q.until);
    }
    if (q.pinnedOnly) clauses.push("m.pinned = 1");
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  }

  async search(q: IndexQuery): Promise<Hit[]> {
    const db = this.conn();
    const params: Array<string | number> = [];
    const match = q.text ? ftsQuery(q.text) : null;
    if (match) {
      params.push(match);
      const where = this.where(q, params);
      params.push(q.limit);
      const rows = db
        .prepare(
          `SELECT m.memoryId AS memoryId, bm25(fts, 2.0, 1.0, 1.5, 1.0) AS rank
           FROM fts JOIN memories m ON m.memoryId = fts.memoryId
           WHERE fts MATCH ? ${where ? `AND ${where.slice(6)}` : ""}
           ORDER BY rank LIMIT ?`
        )
        .all(...params) as Array<{ memoryId: string; rank: number }>;
      if (rows.length === 0) return [];
      // bm25 is negative-better; map to 0..1 with the best hit at 1.
      const best = -(rows[0]?.rank ?? -1);
      return rows.map((r) => ({
        memoryId: r.memoryId,
        relevance: best > 0 ? -r.rank / best : 1,
        source: this.name,
      }));
    }
    const where = this.where(q, params);
    params.push(q.limit);
    const rows = db
      .prepare(
        `SELECT m.memoryId AS memoryId FROM memories m ${where} ORDER BY m.updatedAt DESC LIMIT ?`
      )
      .all(...params) as Array<{ memoryId: string }>;
    return rows.map((r) => ({ memoryId: r.memoryId, relevance: 1, source: this.name }));
  }

  async get(memoryIds: string[]): Promise<Map<string, IndexedMemory>> {
    const out = new Map<string, IndexedMemory>();
    if (memoryIds.length === 0) return out;
    const db = this.conn();
    const stmt = db.prepare("SELECT * FROM memories WHERE memoryId = ?");
    for (const id of memoryIds) {
      const row = stmt.get(id) as Row | undefined;
      if (row) out.set(id, rowToMemory(row));
    }
    return out;
  }

  async count(): Promise<number> {
    return (this.conn().prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  }

  async revisions(): Promise<Record<string, string>> {
    const rows = this.conn().prepare("SELECT shard, revision FROM revisions").all() as Array<{
      shard: string;
      revision: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.shard, r.revision]));
  }

  private writeRevisions(revisions: Record<string, string>): void {
    const db = this.conn();
    db.exec("DELETE FROM revisions");
    const ins = db.prepare("INSERT INTO revisions (shard, revision) VALUES (?, ?)");
    for (const [k, v] of Object.entries(revisions)) ins.run(k, v);
  }

  async setRevisions(revisions: Record<string, string>): Promise<void> {
    const db = this.conn();
    db.exec("BEGIN");
    try {
      this.writeRevisions(revisions);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
