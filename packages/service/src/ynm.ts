import {
  buildContext,
  type ContextBlock,
  type Hit,
  type IndexedMemory,
  type Ranked,
  rank,
} from "@ynm/index";
import type {
  AnnotateInput,
  ContextQuery,
  DreamConfig,
  ForgetInput,
  Level,
  Login,
  MemoryRecord,
  PeopleDoc,
  PurgeInput,
  RecallQuery,
  RecordFilter,
  RememberInput,
  ScoreExplain,
  SupersedeInput,
} from "@ynm/model";
import {
  AnnotateInputSchema,
  COMMON_NAMESPACE,
  ContextQuerySchema,
  ForgetInputSchema,
  loginKey,
  MemoryRecordSchema,
  mergePeopleText,
  NicknameSchema,
  OCCURRENCE_TAG,
  PEOPLE_DOCUMENT,
  PersonIdSchema,
  PurgeInputSchema,
  parsePeople,
  personOfActor,
  RecallQuerySchema,
  RememberInputSchema,
  resolvePerson,
  SupersedeInputSchema,
  summarize,
  ulid,
} from "@ynm/model";
import type { Models } from "@ynm/models";
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
import { RERANK_QUESTION, WRITE_QUESTIONS } from "./dream/questions.js";
import type { FreshnessReport, IndexManager } from "./indexing.js";
import type { Mount } from "./mounts.js";
import { findRedactions, RedactionError } from "./redaction.js";
import { type RemoteStore, RemoteToolError } from "./remote/store.js";

export interface YnmOptions {
  mounts: Mount[];
  actor: string;
  userId: string;
  redaction: readonly string[];
  /** Optional (tests); recall and context require it. */
  index?: IndexManager;
  /** Judge and Writer (ADR-012); optional, resolved by openYnm. */
  models?: Models;
  dream?: DreamConfig;
  now?: () => Date;
  /** Hosted stores mounted over MCP (ADR-004, ADR-017): always the distributed level. */
  remotes?: RemoteStore[];
}

/** How long session context waits for a remote before going on without it. */
export const REMOTE_CONTEXT_TIMEOUT_MS = 3000;
/** The share of the context budget a remote's section may take. */
const REMOTE_CONTEXT_SHARE = 0.4;

/** Reciprocal-rank fusion: merges ranked lists whose scores come from different rankers. */
function fuse(lists: RecallHit[][]): RecallHit[] {
  const fused = new Map<string, { hit: RecallHit; score: number }>();
  for (const list of lists)
    list.forEach((hit, i) => {
      const key = `${hit.mount}:${hit.memoryId}`;
      const prior = fused.get(key);
      const score = (prior?.score ?? 0) + 1 / (60 + i + 1);
      fused.set(key, { hit: prior?.hit ?? hit, score });
    });
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || (a.hit.updatedAt < b.hit.updatedAt ? 1 : -1))
    .map(({ hit, score }) => ({ ...hit, score }));
}

export interface RecallHit {
  memoryId: string;
  mount: string;
  score: number;
  explain?: ScoreExplain;
  type: IndexedMemory["type"];
  level: Level;
  namespace: string;
  subject?: string;
  tags: string[];
  summary: string;
  content: string;
  pinned: boolean;
  importance: number;
  updatedAt: string;
  /** Who last wrote it, when that was a signed-in person: their nickname, else their person id. */
  author?: string;
  /** The structured payload of the current version, when it has one. */
  data?: Record<string, unknown>;
  /** The name of data's shape, when the writer gave one. */
  dataSchema?: string;
  /** The source reference the current version was written with, when it has one. */
  source?: string;
}

/** A hit's structured fields from the folded state; a key is left out when the memory lacks it. */
function structuredFields(m: IndexedMemory): Pick<RecallHit, "data" | "dataSchema" | "source"> {
  const cur = m.state?.current;
  return {
    ...(cur?.data ? { data: cur.data } : {}),
    ...(cur?.dataSchema ? { dataSchema: cur.dataSchema } : {}),
    ...(cur?.provenance.source ? { source: cur.provenance.source } : {}),
  };
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
 * The actor a write made with a hosted server's static token records (ADR-017). The token is a
 * shared secret: everyone holding it is this one actor, never the server's own user.
 */
export const STATIC_TOKEN_ACTOR = "token:static";

/** A signed-in person making a request to a hosted store (ADR-017). */
export interface Caller {
  /** The ynm person id their login resolves to. */
  person: string;
  /** The OAuth client they came through. */
  client?: string;
  /** The login itself, so a person can be told what to link. */
  login?: Login;
}

/**
 * A new memory named no level on a store with no personal level, where it could only be shared
 * (ADR-007). Sharing is chosen, never defaulted, so nothing was stored.
 */
export class ShareRequiredError extends Error {
  constructor() {
    super(
      "nothing stored: this store has no personal level, so a memory stored here is shared with everyone who uses it. To share it, ask the user first, then set level to distributed. To keep it private, store it in a local ynm instead."
    );
    this.name = "ShareRequiredError";
  }
}

/** How long a process trusts its copy of the people document before reading it again. */
const PEOPLE_TTL_MS = 30_000;

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
  readonly index?: IndexManager;
  readonly models?: Models;
  readonly dreamConfig?: DreamConfig;
  readonly remotes: RemoteStore[];
  /** Remotes the latest read had to go without, and why; tools pass it on as guidance. */
  readonly remoteIssues = new Map<string, string>();
  /** Set only on a view made by `as`. */
  readonly caller?: Caller;
  /** Set only on a view made by `asStaticToken`. */
  readonly staticToken?: true;
  private readonly peopleCache: { doc?: PeopleDoc; at: number } = { at: 0 };

  constructor(opts: YnmOptions) {
    this.mounts = opts.mounts;
    this.actor = opts.actor;
    this.userId = opts.userId;
    this.redaction = opts.redaction;
    this.index = opts.index;
    this.models = opts.models;
    this.dreamConfig = opts.dream;
    this.remotes = opts.remotes ?? [];
    const source = opts.now ?? (() => new Date());
    let last = 0;
    // Strictly increasing timestamps within a process keep record order deterministic (ADR-002).
    this.now = () => {
      const t = Math.max(source().getTime(), last + 1);
      last = t;
      return new Date(t);
    };
  }

  /**
   * This store as one signed-in person sees it: what they write is theirs (`user:<person id>`)
   * and lands in `user/<person id>` unless they name a namespace. Shares everything else.
   */
  as(caller: Caller): Ynm {
    const view = Object.create(this) as Ynm;
    Object.defineProperty(view, "caller", { value: caller, enumerable: true });
    return view;
  }

  /**
   * This store as a caller holding the server's static token sees it: what they write is recorded
   * as `token:static`, a shared identity, and lands in `common` unless they name a namespace.
   */
  asStaticToken(): Ynm {
    const view = Object.create(this) as Ynm;
    Object.defineProperty(view, "staticToken", { value: true, enumerable: true });
    return view;
  }

  /** Who a write is recorded as: the signed-in person, the static token, else this process. */
  private writer(): string {
    if (this.caller) return `user:${this.caller.person}`;
    return this.staticToken ? STATIC_TOKEN_ACTOR : this.actor;
  }

  mount(id: string): Mount {
    const m = this.mounts.find((x) => x.id === id);
    if (!m)
      throw new Error(
        `no mount "${id}" (have: ${this.mounts.map((x) => x.id).join(", ") || "none"})`
      );
    return m;
  }

  /**
   * The level a read or a session works at when the caller names none: personal when a personal
   * mount is open, else distributed (a hosted server mounts no personal store). A new memory never
   * defaults to distributed: see `remember`.
   */
  defaultLevel(): Level {
    return this.mounts.some((m) => m.level === "personal") ? "personal" : "distributed";
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
          : "no personal mount available: this store is shared only; set level to distributed to share, or keep it private in a local ynm"
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
      provenance: {
        actor: this.writer(),
        ...(this.caller?.client ? { client: this.caller.client } : {}),
        ...partial.provenance,
      },
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
    await this.index?.afterWrite(mount, record, res);
    return {
      memoryId: record.memoryId,
      recordId: record.id,
      mount: mount.id,
      revision: res.shards[0]?.revision ?? "",
    };
  }

  private requireIndex(): IndexManager {
    if (!this.index) throw new Error("no index configured; recall and context need one");
    return this.index;
  }

  private mountsFor(q: { mount?: string; level?: Level[] }): Mount[] {
    return this.mounts.filter(
      (m) => (!q.mount || m.id === q.mount) && (!q.level?.length || q.level.includes(m.level))
    );
  }

  /** Indexed, ranked recall across mounts (ADR-005). */
  async recall(raw: RecallQuery | Record<string, unknown>): Promise<RecallHit[]> {
    const q = RecallQuerySchema.parse(raw);
    const index = this.requireIndex();
    const out: RecallHit[] = [];
    const candidates = Math.max(q.limit * 4, 40);
    for (const mount of this.mountsFor(q)) {
      const ix = await index.ensureFresh(mount);
      const hits = await ix.search({
        text: q.text,
        type: q.type,
        level: q.level,
        namespace: q.namespace,
        subject: q.subject,
        tags: q.tags,
        dataKey: q.dataKey,
        since: q.since,
        until: q.until,
        pinnedOnly: q.pinnedOnly,
        includeTombstoned: q.includeTombstoned,
        limit: candidates,
      });
      const byId = await ix.get(hits.map((h) => h.memoryId));
      const ranked = rank([hits], byId, { hasText: !!q.text, now: this.now(), explain: q.explain });
      for (const r of ranked) {
        const m = byId.get(r.memoryId);
        if (!m) continue;
        out.push({
          memoryId: m.memoryId,
          mount: mount.id,
          score: r.score,
          explain: r.explain,
          type: m.type,
          level: m.level,
          namespace: m.namespace,
          subject: m.subject,
          tags: m.tags,
          summary: m.summary,
          content: m.content,
          pinned: m.pinned,
          importance: m.importance,
          updatedAt: m.updatedAt,
          ...(await this.authorField(m.state?.current.provenance.actor)),
          ...structuredFields(m),
        });
      }
    }
    out.sort((a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : -1));
    const remote = await this.remoteRecall(q);
    return this.rerank(q, remote.length ? fuse([out, ...remote]) : out);
  }

  /** The remotes a read reaches: distributed ones, unless the query names another mount or level. */
  private remotesFor(q: { mount?: string; level?: Level[] }): RemoteStore[] {
    return this.remotes.filter(
      (r) => (!q.mount || r.id === q.mount) && (!q.level?.length || q.level.includes("distributed"))
    );
  }

  /** Each reachable remote's hits for the query; a remote that fails is noted and skipped. */
  private async remoteRecall(q: RecallQuery): Promise<RecallHit[][]> {
    const { mount: _m, level: _l, ...query } = q;
    const lists = await Promise.all(
      this.remotesFor(q).map(async (r) => {
        try {
          const hits = await r.call<RecallHit[]>("memory_recall", query);
          this.remoteIssues.delete(r.id);
          return (hits ?? []).map((h) => ({ ...h, mount: r.id }));
        } catch (err) {
          this.remoteIssues.set(r.id, (err as Error).message);
          return [];
        }
      })
    );
    return lists.filter((l) => l.length);
  }

  /**
   * Judge-backed final stage (ADR-005): one noul per top candidate asking whether the memory
   * answers the query; skipped without a calibrated judge or when disabled.
   */
  private async rerank(q: RecallQuery, ranked: RecallHit[]): Promise<RecallHit[]> {
    const judge = this.models?.judge;
    const cfg = this.dreamConfig;
    if (!q.text || !judge?.calibrated || !cfg?.rerank || q.rerank === false)
      return ranked.slice(0, q.limit);
    const top = ranked.slice(0, Math.max(q.limit, cfg.rerankTopK));
    const scored = await Promise.all(
      top.map(async (h) => {
        try {
          const j = await judge.judge(
            {
              query: q.text ?? "",
              memory: { summary: h.summary, content: h.content.slice(0, 2000) },
            },
            RERANK_QUESTION
          );
          const p = (j.answers.answers as { noul: number }).noul;
          const explain = h.explain
            ? { ...h.explain, relevance: p, total: 0.7 * p + 0.3 * h.score }
            : undefined;
          return { ...h, score: 0.7 * p + 0.3 * h.score, explain };
        } catch {
          return h;
        }
      })
    );
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, q.limit);
  }

  /** Pinned plus top memories packed to a token budget, as markdown (ADR-005). */
  async context(raw: ContextQuery | Record<string, unknown>): Promise<ContextBlock> {
    const q = ContextQuerySchema.parse(raw);
    const index = this.requireIndex();
    const pinned: IndexedMemory[] = [];
    const lists: Hit[][] = [];
    const byId = new Map<string, IndexedMemory>();
    for (const mount of this.mountsFor(q)) {
      const ix = await index.ensureFresh(mount);
      // Occurrences never reach the block (buildContext drops them too); leaving them out of the
      // search keeps a long run of repeats from crowding out the candidates that can.
      const base = {
        namespace: q.namespace,
        level: q.level,
        type: q.type,
        excludeTags: [OCCURRENCE_TAG],
      };
      const p = await ix.search({ ...base, pinnedOnly: true, limit: 200 });
      for (const m of (await ix.get(p.map((h) => h.memoryId))).values()) pinned.push(m);
      const hits = await ix.search({ ...base, text: q.text, limit: 100 });
      lists.push(hits);
      for (const [id, m] of await ix.get(hits.map((h) => h.memoryId))) byId.set(id, m);
    }
    const ranked: Ranked[] = rank([lists.flat()], byId, { hasText: !!q.text, now: this.now() });
    pinned.sort((a, b) => b.importance - a.importance || (a.updatedAt < b.updatedAt ? 1 : -1));
    const remote = await this.remoteContext(q);
    const used = remote.reduce((n, b) => n + b.tokens, 0);
    const local = buildContext(pinned, ranked, byId, q.budgetTokens - used);
    if (!remote.length) return local;
    return {
      // An empty personal section has empty markdown, so it drops out here.
      markdown: [local.markdown, ...remote.map((b) => b.markdown)].filter(Boolean).join("\n"),
      included: [local.included, ...remote.map((b) => b.included)].flat(),
      tokens: local.tokens + used,
      truncated: local.truncated || remote.some((b) => b.truncated),
    };
  }

  /**
   * Each remote's own context section, within its share of the budget and a short timeout, so a
   * slow or unreachable hosted store never holds up a session; it is noted and left out.
   */
  private async remoteContext(q: {
    mount?: string;
    level?: Level[];
    namespace?: string;
    text?: string;
    budgetTokens: number;
  }): Promise<ContextBlock[]> {
    const remotes = this.remotesFor(q);
    if (!remotes.length) return [];
    const share = Math.floor((q.budgetTokens * REMOTE_CONTEXT_SHARE) / remotes.length);
    const blocks = await Promise.all(
      remotes.map(async (r) => {
        try {
          const block = await r.context(
            { namespace: q.namespace, text: q.text, budgetTokens: share },
            REMOTE_CONTEXT_TIMEOUT_MS
          );
          this.remoteIssues.delete(r.id);
          return block.included.length
            ? {
                ...block,
                markdown: block.markdown.replace(/^## Memory\n/, `## Shared memory (${r.id})\n`),
              }
            : undefined;
        } catch (err) {
          this.remoteIssues.set(r.id, (err as Error).message);
          return undefined;
        }
      })
    );
    return blocks.filter((b): b is ContextBlock => !!b);
  }

  async reindex(mountId?: string): Promise<Record<string, number>> {
    const index = this.requireIndex();
    const out: Record<string, number> = {};
    for (const mount of this.mounts) {
      if (mountId && mount.id !== mountId) continue;
      out[mount.id] = await index.rebuild(mount);
    }
    return out;
  }

  async pin(memoryId: string, pinned = true): Promise<WriteResult> {
    return this.annotate({ memoryId, pinned, reason: pinned ? "pinned" : "unpinned" });
  }

  /** Physical removal with an audit marker (ADR-002). History stays unless forgetHistory. */
  async purge(
    raw: PurgeInput | Record<string, unknown>
  ): Promise<{ memoryId: string; removed: number; mount: string }> {
    const input = PurgeInputSchema.parse(raw);
    const prior = await this.existing(input.memoryId);
    const mount = this.mount(prior.mount);
    const res = await mount.log.purge(input.memoryId, { forgetHistory: input.forgetHistory });
    const marker = this.stamp({
      memoryId: input.memoryId,
      op: "purge-marker",
      type: prior.type,
      level: prior.level,
      namespace: prior.namespace,
      tags: [],
      links: [],
      reason: `${input.reason}${input.forgetHistory ? " (history dropped)" : ""}`,
      provenance: {},
    });
    await mount.log.append([marker]);
    if (this.index) {
      const ix = await this.index.indexFor(mount);
      await ix.remove([input.memoryId]);
      await this.index.rebuild(mount);
    }
    return { memoryId: input.memoryId, removed: res.removed, mount: mount.id };
  }

  /** Memories waiting for a human or agent decision after a low-confidence model call. */
  async reviewQueue(mountId?: string): Promise<MemoryWithMount[]> {
    return (await this.list({ includeTombstoned: false, mount: mountId })).filter(
      (m) => m.needsReview
    );
  }

  async indexStatus(): Promise<FreshnessReport[]> {
    if (!this.index) return [];
    const out: FreshnessReport[] = [];
    for (const mount of this.mounts) out.push(await this.index.freshness(mount));
    return out;
  }

  /** Where a record goes when the caller names no namespace (ADR-001 well-known namespaces). */
  defaultNamespace(level: Level): string {
    return level === "personal" ? `user/${this.userId}` : "common";
  }

  /**
   * Write-path judge (ADR-012, decided): when a calibrated judge is available, score importance
   * (only if the caller left the default) and refuse content it flags as sensitive.
   */
  private async judgeOnWrite(
    input: RememberInput
  ): Promise<{ importance?: number; judgment?: Record<string, unknown> }> {
    const judge = this.models?.judge;
    if (!judge?.calibrated || this.dreamConfig?.judgeOnWrite === false) return {};
    try {
      const j = await judge.judge(
        {
          memory: {
            type: input.type,
            content: input.content.slice(0, 4000),
            summary: input.summary ?? "",
          },
        },
        WRITE_QUESTIONS
      );
      const sensitive = (j.answers.sensitive as { noul: number }).noul;
      if (sensitive >= 0.9)
        throw new RedactionError([
          { pattern: "judge:sensitive", sample: `p=${sensitive.toFixed(2)}` },
        ]);
      const score = j.answers.importance as { score: number; confidence: number };
      const importance =
        input.importance === 0.5 && score.confidence >= 0.5 ? score.score / 4 : undefined;
      return {
        importance,
        judgment: {
          judgments: [
            {
              pass: "write",
              model: j.model,
              calibrated: j.calibrated,
              at: this.now().toISOString(),
              questions: WRITE_QUESTIONS,
              answers: j.answers,
              usage: j.usage,
            },
          ],
        },
      };
    } catch (e) {
      if (e instanceof RedactionError) throw e;
      return {};
    }
  }

  async remember(
    raw: RememberInput | Record<string, unknown>,
    mountId?: string
  ): Promise<WriteResult> {
    const input = RememberInputSchema.parse(raw);
    // Personal by default; sharing is chosen. Where only sharing is possible, it must be asked for.
    if (input.level === undefined && !this.mounts.some((m) => m.level === "personal"))
      throw new ShareRequiredError();
    const level = input.level ?? "personal";
    const remote = this.remoteTarget(level, mountId);
    if (remote) {
      this.guard(level, [input.content, input.summary, JSON.stringify(input.data ?? null)]);
      const { level: _l, ...rest } = input;
      return this.onRemote(remote, "memory_remember", { ...rest, level: "distributed" });
    }
    const namespace = this.namespaceFor(level, input.namespace);
    const mount = this.routeFor(level, mountId);
    this.guard(level, [input.content, input.summary, JSON.stringify(input.data ?? null)]);
    const judged = await this.judgeOnWrite(input);
    const record = this.stamp({
      memoryId: "",
      op: "create",
      type: input.type,
      level,
      namespace,
      subject: input.subject,
      tags: input.tags,
      content: input.content,
      summary: input.summary ?? summarize(input.content),
      dataSchema: input.dataSchema,
      importance: judged.importance ?? input.importance,
      confidence: input.confidence,
      validFrom: input.validFrom,
      validTo: input.validTo,
      ttl: input.ttl,
      links: input.links,
      data: judged.judgment ? { ...(input.data ?? {}), ...judged.judgment } : input.data,
      provenance: { session: input.session, source: input.source },
    });
    return this.write(mount, record);
  }

  /**
   * Where a write goes when it names no namespace: the writer's own. On a personal mount that is
   * `user/<user id>` (as is `common`, which never leaves the machine); for a signed-in person on
   * a hosted store it is `user/<person id>`; otherwise `common`.
   */
  private namespaceFor(level: Level, named: string | undefined): string {
    if (level === "personal" && (named === undefined || named === COMMON_NAMESPACE))
      return `user/${this.userId}`;
    if (named !== undefined) return named;
    return this.caller ? `user/${this.caller.person}` : COMMON_NAMESPACE;
  }

  /**
   * The remote a write goes to: the one named, or, for a distributed write with no local
   * distributed mount to take it, the first remote.
   */
  private remoteTarget(level: Level, mountId?: string): RemoteStore | undefined {
    if (mountId) return this.remotes.find((r) => r.id === mountId);
    if (level !== "distributed" || this.mounts.some((m) => m.level === "distributed")) return;
    return this.remotes[0];
  }

  /** A write on a remote, answered in the local shape with the remote as its mount. */
  private async onRemote(
    remote: RemoteStore,
    tool: string,
    args: Record<string, unknown>
  ): Promise<WriteResult> {
    const r = await remote.call<WriteResult>(tool, args);
    return { ...r, mount: remote.id };
  }

  /**
   * An edit (supersede, annotate, forget) of a memory no local mount holds goes to the remotes,
   * in order, until one has it.
   */
  private async editRemote(
    memoryId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<WriteResult> {
    for (const remote of this.remotes) {
      try {
        return await this.onRemote(remote, tool, args);
      } catch (err) {
        if (err instanceof RemoteToolError && /unknown memory/.test(err.message)) continue;
        throw err;
      }
    }
    throw new Error(`unknown memory ${memoryId}`);
  }

  /** The distributed mount that keeps the people document, when its provider can. */
  private peopleMount(): Mount | undefined {
    const m =
      this.mounts.find((x) => x.level === "distributed" && x.id === "project") ??
      this.mounts.find((x) => x.level === "distributed");
    return m?.log.readDocument && m.log.writeDocument ? m : undefined;
  }

  /** Nicknames and linked logins; cached briefly, since every signed-in request resolves one. */
  async people(fresh = false): Promise<PeopleDoc> {
    const cache = this.peopleCache;
    if (!fresh && cache.doc && this.now().getTime() - cache.at < PEOPLE_TTL_MS) return cache.doc;
    const mount = this.peopleMount();
    const doc = parsePeople((await mount?.log.readDocument?.(PEOPLE_DOCUMENT))?.text);
    cache.doc = doc;
    cache.at = this.now().getTime();
    return doc;
  }

  /**
   * Who wrote something, for display, when a signed-in person did: their nickname, else their
   * person id. Undefined for every other actor, which listings already identify by level.
   */
  async authorOf(actor: string | undefined): Promise<string | undefined> {
    const person = personOfActor(actor);
    if (!person) return undefined;
    return (await this.people()).people[person]?.nickname ?? person;
  }

  private async authorField(actor: string | undefined): Promise<{ author?: string }> {
    const author = await this.authorOf(actor);
    return author ? { author } : {};
  }

  /** The person a login belongs to. */
  async personFor(login: Login): Promise<string> {
    return resolvePerson(await this.people(), login);
  }

  /** Read, change and write the people document, retrying when someone else wrote first. */
  private async updatePeople(change: (doc: PeopleDoc) => void): Promise<PeopleDoc> {
    const mount = this.peopleMount();
    if (!mount?.log.readDocument || !mount.log.writeDocument)
      throw new Error("this store keeps no people (it has no distributed mount that can)");
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await mount.log.readDocument(PEOPLE_DOCUMENT);
      const doc = parsePeople(current?.text);
      change(doc);
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      if (await mount.log.writeDocument(PEOPLE_DOCUMENT, text, current?.version ?? null)) {
        this.peopleCache.doc = doc;
        this.peopleCache.at = this.now().getTime();
        return doc;
      }
    }
    throw new Error("the people document kept changing underneath this write; try again");
  }

  /** Sets (or, with no nickname, clears) how a person appears to everyone who reads the store. */
  async setNickname(person: string, nickname: string | undefined): Promise<PeopleDoc> {
    const id = PersonIdSchema.parse(person);
    const name = nickname === undefined ? undefined : NicknameSchema.parse(nickname);
    return this.updatePeople((doc) => {
      const prior = doc.people[id];
      doc.people[id] = {
        logins: prior?.logins ?? [],
        ...(name ? { nickname: name } : {}),
        updatedAt: this.now().toISOString(),
      };
    });
  }

  /**
   * Links a login to an existing person, so signing in with it (say, through a new identity
   * provider) writes as that person. A login belongs to one person; linking moves it.
   */
  async linkLogin(login: Login, person: string): Promise<PeopleDoc> {
    const id = PersonIdSchema.parse(person);
    const key = loginKey(login);
    return this.updatePeople((doc) => {
      const at = this.now().toISOString();
      for (const [other, p] of Object.entries(doc.people))
        if (other !== id && p.logins.includes(key))
          doc.people[other] = { ...p, logins: p.logins.filter((l) => l !== key), updatedAt: at };
      const prior = doc.people[id];
      doc.people[id] = {
        ...prior,
        logins: [...new Set([...(prior?.logins ?? []), key])],
        updatedAt: at,
      };
    });
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
    if (this.remotes.length && !(await this.find(input.memoryId)))
      return this.editRemote(input.memoryId, "memory_supersede", input);
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
    if (this.remotes.length && !(await this.find(input.memoryId)))
      return this.editRemote(input.memoryId, "memory_annotate", input);
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
    if (this.remotes.length && !(await this.find(input.memoryId)))
      return this.editRemote(input.memoryId, "memory_forget", input);
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
    const cur = prior.current;
    this.guard("distributed", [cur.content, cur.summary, JSON.stringify(cur.data ?? null)]);
    const remote = this.remoteTarget("distributed", mountId);
    if (remote)
      // A copy, shared through the hosted store as the signed-in person; the personal original
      // stays here, and its id means nothing there, so no link back.
      return this.onRemote(remote, "memory_remember", {
        type: prior.type,
        level: "distributed",
        ...(prior.namespace.startsWith("user/") ? {} : { namespace: prior.namespace }),
        subject: prior.subject,
        tags: prior.tags,
        content: cur.content,
        summary: cur.summary,
        data: cur.data,
        dataSchema: cur.dataSchema,
        importance: prior.importance,
        confidence: prior.confidence,
        source: `promoted:${prior.mount}`,
      });
    const target = this.routeFor("distributed", mountId);
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
        if (f.needsReview !== undefined && m.needsReview !== f.needsReview) continue;
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
      results[mount.id] = await mount.log.sync({
        ...opts,
        mergeDocuments: { [PEOPLE_DOCUMENT]: mergePeopleText, ...opts.mergeDocuments },
      });
    }
    return results;
  }

  async status(): Promise<{
    mounts: Array<{
      id: string;
      level: Level;
      provider: string;
      location: string;
      shards: number;
      error?: string;
    }>;
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
    // A remote's shards are the hosted store's own; -1 when it could not be asked.
    for (const r of this.remotes) {
      try {
        const s = await r.call<{ mounts: Array<{ shards: number }> }>("memory_status", {}, 5000);
        const shards = (s?.mounts ?? []).reduce((n, m) => n + m.shards, 0);
        mounts.push({ id: r.id, level: r.level, provider: r.provider, location: r.url, shards });
      } catch (err) {
        mounts.push({
          id: r.id,
          level: r.level,
          provider: r.provider,
          location: r.url,
          shards: -1,
          error: (err as Error).message,
        });
      }
    }
    return { mounts };
  }

  static logOf(mount: Mount): RecordLog {
    return mount.log;
  }
}
