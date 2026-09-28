import type {
  AnnotateInput,
  ForgetInput,
  Level,
  MemoryRecord,
  RecordFilter,
  RememberInput,
  SupersedeInput,
} from "@ynm/model";
import {
  AnnotateInputSchema,
  ForgetInputSchema,
  MemoryRecordSchema,
  RememberInputSchema,
  SupersedeInputSchema,
  summarize,
  ulid,
} from "@ynm/model";
import {
  fold,
  type Memory,
  type ParseProblem,
  parseJsonl,
  type RecordLog,
  type ShardFilter,
  type SyncOptions,
  type SyncResult,
  serializeJsonl,
} from "@ynm/store";
import type { Mount } from "./mounts.js";
import { findRedactions, RedactionError } from "./redaction.js";

export interface YnmOptions {
  mounts: Mount[];
  actor: string;
  userId: string;
  redaction: readonly string[];
  now?: () => Date;
}

export interface MemoryWithMount extends Memory {
  mount: string;
}

export interface WriteResult {
  memoryId: string;
  recordId: string;
  mount: string;
  revision: string;
}

export interface ListOptions extends RecordFilter {
  mount?: string;
}

/**
 * The one business layer (ADR-008). Routes writes by level, folds reads across mounts, and
 * applies the redaction gate before anything reaches a distributed log (ADR-007).
 */
export class Ynm {
  readonly mounts: Mount[];
  private readonly actor: string;
  private readonly userId: string;
  private readonly redaction: readonly string[];
  private readonly now: () => Date;

  constructor(opts: YnmOptions) {
    this.mounts = opts.mounts;
    this.actor = opts.actor;
    this.userId = opts.userId;
    this.redaction = opts.redaction;
    const source = opts.now ?? (() => new Date());
    let last = 0;
    // Strictly increasing timestamps within a process keep record order deterministic (ADR-002).
    this.now = () => {
      const t = Math.max(source().getTime(), last + 1);
      last = t;
      return new Date(t);
    };
  }

  mount(id: string): Mount {
    const m = this.mounts.find((x) => x.id === id);
    if (!m)
      throw new Error(
        `no mount "${id}" (have: ${this.mounts.map((x) => x.id).join(", ") || "none"})`
      );
    return m;
  }

  /** Personal → the personal mount; distributed → "project" unless a mount is named. */
  routeFor(level: Level, mountId?: string): Mount {
    if (mountId) {
      const m = this.mount(mountId);
      if (m.level !== level)
        throw new Error(`mount "${mountId}" is ${m.level}; cannot take a ${level} record`);
      return m;
    }
    const m =
      this.mounts.find((x) => x.level === level && (level === "personal" || x.id === "project")) ??
      this.mounts.find((x) => x.level === level);
    if (!m) {
      throw new Error(
        level === "distributed"
          ? "no distributed mount: run `ynm init` in the project (or configure a mount)"
          : "no personal mount available"
      );
    }
    return m;
  }

  private stamp(
    partial: Omit<MemoryRecord, "v" | "id" | "recordedAt" | "provenance"> & {
      provenance?: Partial<MemoryRecord["provenance"]>;
    }
  ): MemoryRecord {
    const at = this.now();
    const id = ulid(at.getTime());
    const record = {
      ...partial,
      v: 1 as const,
      id,
      memoryId: partial.op === "create" ? id : partial.memoryId,
      recordedAt: at.toISOString(),
      provenance: { actor: this.actor, ...partial.provenance },
    };
    return MemoryRecordSchema.parse(record);
  }

  private guard(level: Level, texts: Array<string | undefined>): void {
    if (level !== "distributed") return;
    const hits = findRedactions(texts.filter((t): t is string => !!t).join("\n"), this.redaction);
    if (hits.length) throw new RedactionError(hits);
  }

  private async write(mount: Mount, record: MemoryRecord): Promise<WriteResult> {
    const res = await mount.log.append([record]);
    return {
      memoryId: record.memoryId,
      recordId: record.id,
      mount: mount.id,
      revision: res.shards[0]?.revision ?? "",
    };
  }

  async remember(
    raw: RememberInput | Record<string, unknown>,
    mountId?: string
  ): Promise<WriteResult> {
    const input = RememberInputSchema.parse(raw);
    const namespace =
      input.namespace === "common" && input.level === "personal"
        ? `user/${this.userId}`
        : input.namespace;
    const mount = this.routeFor(input.level, mountId);
    this.guard(input.level, [input.content, input.summary, JSON.stringify(input.data ?? null)]);
    const record = this.stamp({
      memoryId: "",
      op: "create",
      type: input.type,
      level: input.level,
      namespace,
      subject: input.subject,
      tags: input.tags,
      content: input.content,
      summary: input.summary ?? summarize(input.content),
      data: input.data,
      dataSchema: input.dataSchema,
      importance: input.importance,
      confidence: input.confidence,
      validFrom: input.validFrom,
      validTo: input.validTo,
      ttl: input.ttl,
      links: input.links,
      provenance: { session: input.session, source: input.source },
    });
    return this.write(mount, record);
  }

  async find(memoryId: string): Promise<MemoryWithMount | null> {
    for (const mount of this.mounts) {
      const records: MemoryRecord[] = [];
      for await (const r of mount.log.scan()) if (r.memoryId === memoryId) records.push(r);
      if (records.length) {
        const m = fold(records).memories.get(memoryId);
        if (m) return { ...m, mount: mount.id };
      }
    }
    return null;
  }

  private async existing(memoryId: string): Promise<MemoryWithMount> {
    const m = await this.find(memoryId);
    if (!m) throw new Error(`unknown memory ${memoryId}`);
    return m;
  }

  async supersede(raw: SupersedeInput | Record<string, unknown>): Promise<WriteResult> {
    const input = SupersedeInputSchema.parse(raw);
    const prior = await this.existing(input.memoryId);
    const mount = this.mount(prior.mount);
    this.guard(prior.level, [input.content, input.summary, JSON.stringify(input.data ?? null)]);
    const record = this.stamp({
      memoryId: prior.memoryId,
      op: "supersede",
      type: prior.type,
      level: prior.level,
      namespace: prior.namespace,
      subject: input.subject ?? prior.subject,
      tags: input.tags,
      content: input.content,
      summary: input.summary ?? summarize(input.content),
      data: input.data,
      dataSchema: input.dataSchema,
      importance: input.importance,
      confidence: input.confidence,
      validFrom: input.validFrom,
      validTo: input.validTo,
      links: [{ rel: "supersedes", to: prior.memoryId }, ...input.links],
      provenance: { session: input.session, source: input.source },
    });
    return this.write(mount, record);
  }

  async annotate(raw: AnnotateInput | Record<string, unknown>): Promise<WriteResult> {
    const input = AnnotateInputSchema.parse(raw);
    const prior = await this.existing(input.memoryId);
    const record = this.stamp({
      memoryId: prior.memoryId,
      op: "annotate",
      type: prior.type,
      level: prior.level,
      namespace: prior.namespace,
      tags: input.tags ?? [],
      links: input.links ?? [],
      importance: input.importance,
      confidence: input.confidence,
      pinned: input.pinned,
      needsReview: input.needsReview,
      reason: input.reason,
      data: input.data,
      provenance: { session: input.session },
    });
    return this.write(this.mount(prior.mount), record);
  }

  async forget(raw: ForgetInput | Record<string, unknown>): Promise<WriteResult> {
    const input = ForgetInputSchema.parse(raw);
    const prior = await this.existing(input.memoryId);
    const record = this.stamp({
      memoryId: prior.memoryId,
      op: "tombstone",
      type: prior.type,
      level: prior.level,
      namespace: prior.namespace,
      tags: [],
      links: [],
      reason: input.reason,
      provenance: { session: input.session },
    });
    return this.write(this.mount(prior.mount), record);
  }

  /** Copies a personal memory into a distributed mount as a new memory linked derives-from (ADR-007). */
  async promote(memoryId: string, mountId?: string): Promise<WriteResult> {
    const prior = await this.existing(memoryId);
    if (prior.level !== "personal") throw new Error(`memory ${memoryId} is already distributed`);
    const target = this.routeFor("distributed", mountId);
    const cur = prior.current;
    this.guard("distributed", [cur.content, cur.summary, JSON.stringify(cur.data ?? null)]);
    const record = this.stamp({
      memoryId: "",
      op: "create",
      type: prior.type,
      level: "distributed",
      namespace: prior.namespace.startsWith("user/") ? "common" : prior.namespace,
      subject: prior.subject,
      tags: prior.tags,
      content: cur.content,
      summary: cur.summary,
      data: cur.data,
      dataSchema: cur.dataSchema,
      importance: prior.importance,
      confidence: prior.confidence,
      links: [{ rel: "derives-from", to: prior.memoryId }],
      provenance: { source: `promoted:${prior.mount}` },
    });
    return this.write(target, record);
  }

  private static shardFilter(f: ListOptions): ShardFilter {
    return {
      level: f.level,
      type: f.type,
      namespace: f.namespace,
      fromBucket: f.since?.slice(0, 7),
      toBucket: f.until?.slice(0, 7),
    };
  }

  /** Raw records across mounts, for export and diagnostics. */
  async records(
    f: ListOptions = { includeTombstoned: false },
    onProblem?: (m: string, p: ParseProblem) => void
  ): Promise<Array<MemoryRecord & { mount: string }>> {
    const out: Array<MemoryRecord & { mount: string }> = [];
    for (const mount of this.mounts) {
      if (f.mount && mount.id !== f.mount) continue;
      if (f.level && mount.level !== f.level) continue;
      for await (const r of mount.log.scan(Ynm.shardFilter(f), (p) => onProblem?.(mount.id, p)))
        out.push({ ...r, mount: mount.id });
    }
    return out;
  }

  /** Folded memories across mounts, newest first (ADR-004). */
  async list(f: ListOptions = { includeTombstoned: false }): Promise<MemoryWithMount[]> {
    const out: MemoryWithMount[] = [];
    for (const mount of this.mounts) {
      if (f.mount && mount.id !== f.mount) continue;
      if (f.level && mount.level !== f.level) continue;
      const records: MemoryRecord[] = [];
      for await (const r of mount.log.scan(Ynm.shardFilter(f))) records.push(r);
      for (const m of fold(records).memories.values()) {
        if (m.tombstoned && !f.includeTombstoned) continue;
        if (f.since && m.updatedAt < f.since) continue;
        if (f.until && m.updatedAt > f.until) continue;
        out.push({ ...m, mount: mount.id });
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return f.limit ? out.slice(0, f.limit) : out;
  }

  async exportJsonl(f: ListOptions = { includeTombstoned: true }): Promise<string> {
    const records = await this.records(f);
    return serializeJsonl(records.map(({ mount: _m, ...r }) => r));
  }

  /** Imports JSONL, routing each record by its level; bad lines are reported, not fatal. */
  async importJsonl(
    text: string,
    mountId?: string
  ): Promise<{ imported: number; problems: string[] }> {
    const { records, problems } = parseJsonl(text);
    const byMount = new Map<Mount, MemoryRecord[]>();
    for (const r of records) {
      const mount = this.routeFor(r.level, mountId);
      this.guard(r.level, [r.content, r.summary]);
      const list = byMount.get(mount) ?? [];
      list.push(r);
      byMount.set(mount, list);
    }
    let imported = 0;
    for (const [mount, list] of byMount) imported += (await mount.log.append(list)).appended;
    return { imported, problems: problems.map((p) => `line ${p.line}: ${p.message}`) };
  }

  /** Syncs every replicating distributed mount. Personal mounts sync only when named explicitly. */
  async sync(opts: SyncOptions & { mount?: string } = {}): Promise<Record<string, SyncResult>> {
    const results: Record<string, SyncResult> = {};
    for (const mount of this.mounts) {
      if (opts.mount ? mount.id !== opts.mount : mount.level !== "distributed") continue;
      if (!mount.log.sync) continue;
      results[mount.id] = await mount.log.sync(opts);
    }
    return results;
  }

  async status(): Promise<{
    mounts: Array<{ id: string; level: Level; provider: string; location: string; shards: number }>;
  }> {
    const mounts = [];
    for (const m of this.mounts)
      mounts.push({
        id: m.id,
        level: m.level,
        provider: m.log.provider,
        location: m.location,
        shards: (await m.log.shards()).length,
      });
    return { mounts };
  }

  static logOf(mount: Mount): RecordLog {
    return mount.log;
  }
}
