import { join } from "node:path";
import type { Level, MemoryRecord } from "@ynm/model";
import { withLock } from "../../lock.js";
import {
  type AppendResult,
  assertLevel,
  groupByShard,
  type HealthReport,
  type ParseProblem,
  type PurgeResult,
  type RecordLog,
  type ShardFilter,
  type ShardInfo,
  type ShardKey,
  type StoreDocument,
  type SyncOptions,
  type SyncResult,
  shardMatches,
} from "../../log.js";
import { parseJsonl, serializeJsonl } from "../../parse.js";
import { objectPresent } from "./anchor.js";
import { assertDocumentName, commitDocument, readDocumentAt } from "./documents.js";
import { assertSha, git, gitCommonDir, gitOrNull, identityEnv } from "./git.js";
import { documentRef, keyFromRef, NOTES_PREFIX, refFor, refPrefixFor } from "./refs.js";
import { syncDistributed } from "./sync.js";

export interface GitNotesLogOptions {
  /** Repository path (work tree or bare). */
  repo: string;
  /** Anchor commit sha; every note hangs off it (ADR-003). */
  anchor: string;
  /** Remote name for sync; default origin. */
  remote?: string;
  /** Test seam: runs between reading the ref tip and the compare-and-swap update. */
  beforeUpdateRef?: (ref: string) => Promise<void>;
}

const MAX_CAS_RETRIES = 5;
const LOCK_TIMEOUT_MS = 60_000;

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

function parseLsTree(out: string): TreeEntry[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = (meta ?? "").split(" ");
      return { mode: mode ?? "", type: type ?? "", sha: sha ?? "", path: path ?? "" };
    });
}

/** Note paths may be fanned out (ab/cdef...); compare with separators removed. */
function isAnchorPath(path: string, anchor: string): boolean {
  return path.replace(/\//g, "") === anchor;
}

/**
 * git notes provider (ADR-003): one blob per shard ref attached to the anchor commit, written
 * with plumbing under a lock and an `update-ref` compare-and-swap, read with two processes.
 */
export class GitNotesLog implements RecordLog {
  readonly provider = "git-notes";
  readonly repo: string;
  readonly anchor: string;
  readonly remote: string;
  private readonly beforeUpdateRef?: (ref: string) => Promise<void>;
  private commonDir: string | null = null;
  private env: NodeJS.ProcessEnv | null = null;

  constructor(
    readonly id: string,
    readonly level: Level,
    options: GitNotesLogOptions
  ) {
    assertSha(options.anchor);
    this.repo = options.repo;
    this.anchor = options.anchor;
    this.remote = options.remote ?? "origin";
    this.beforeUpdateRef = options.beforeUpdateRef;
  }

  private async lockPath(): Promise<string> {
    this.commonDir ??= await gitCommonDir(this.repo);
    return join(this.commonDir, "ynm.lock");
  }

  private async identity(): Promise<NodeJS.ProcessEnv> {
    this.env ??= await identityEnv(this.repo);
    return this.env;
  }

  private async tip(ref: string): Promise<string | null> {
    const out = await gitOrNull(["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
      cwd: this.repo,
    });
    return out ? out.trim() : null;
  }

  private async readTree(commit: string): Promise<TreeEntry[]> {
    return parseLsTree(await git(["ls-tree", "-r", commit], { cwd: this.repo }));
  }

  private async readNote(commit: string | null): Promise<{ content: string; others: TreeEntry[] }> {
    if (!commit) return { content: "", others: [] };
    const entries = await this.readTree(commit);
    const mine = entries.find((e) => isAnchorPath(e.path, this.anchor));
    const others = entries.filter((e) => e !== mine);
    const content = mine ? await git(["cat-file", "blob", mine.sha], { cwd: this.repo }) : "";
    return { content, others };
  }

  private async writeShard(
    key: ShardKey,
    records: MemoryRecord[]
  ): Promise<{ revision: string; previous: string | null }> {
    const ref = refFor(key);
    const env = await this.identity();
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const old = await this.tip(ref);
      const { content, others } = await this.readNote(old);
      const blob = (
        await git(["hash-object", "-w", "--stdin"], {
          cwd: this.repo,
          input: content + serializeJsonl(records),
        })
      ).trim();
      const treeLines = [
        ...others.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`),
        `100644 blob ${blob}\t${this.anchor}`,
      ];
      const tree = (
        await git(["mktree"], { cwd: this.repo, input: `${treeLines.join("\n")}\n` })
      ).trim();
      const message = `ynm: ${records.length} record${records.length === 1 ? "" : "s"} ${key.level}/${key.namespace}/${key.type}/${key.bucket}`;
      const parentArgs = old ? ["-p", old] : [];
      const commit = (
        await git(["commit-tree", tree, ...parentArgs, "-m", message], { cwd: this.repo, env })
      ).trim();
      await this.beforeUpdateRef?.(ref);
      const expected = old ?? "0".repeat(commit.length);
      const updated = await gitOrNull(["update-ref", ref, commit, expected], { cwd: this.repo });
      if (updated !== null) return { revision: commit, previous: old };
    }
    throw new Error(`compare-and-swap failed after ${MAX_CAS_RETRIES} attempts on ${ref}`);
  }

  async append(records: readonly MemoryRecord[]): Promise<AppendResult> {
    assertLevel(this, records);
    if (records.length === 0) return { appended: 0, shards: [] };
    const groups = [...groupByShard(records).values()];
    const lock = await this.lockPath();
    const shards = await withLock(
      lock,
      async () => {
        const out: AppendResult["shards"] = [];
        for (const g of groups)
          out.push({ key: g.key, ...(await this.writeShard(g.key, g.records)) });
        return out;
      },
      LOCK_TIMEOUT_MS
    );
    return { appended: records.length, shards };
  }

  private async listRefs(
    filter?: ShardFilter
  ): Promise<Array<{ ref: string; key: ShardKey; sha: string }>> {
    const prefix = filter?.level
      ? refPrefixFor(filter.level, filter.namespace)
      : `${NOTES_PREFIX}/`;
    const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], {
      cwd: this.repo,
    });
    const refs: Array<{ ref: string; key: ShardKey; sha: string }> = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      if (!ref || !sha) continue;
      const key = keyFromRef(ref);
      if (key && key.level === this.level && shardMatches(key, filter))
        refs.push({ ref, key, sha });
    }
    return refs;
  }

  /** One cat-file --batch for every shard: flat and one-level fanout candidates per ref. */
  private async readAll(refs: Array<{ ref: string; key: ShardKey }>): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    if (refs.length === 0) return contents;
    const a = this.anchor;
    const specs: Array<{ ref: string; spec: string }> = [];
    for (const { ref } of refs) {
      specs.push({ ref, spec: `${ref}:${a}` });
      specs.push({ ref, spec: `${ref}:${a.slice(0, 2)}/${a.slice(2)}` });
      specs.push({ ref, spec: `${ref}:${a.slice(0, 2)}/${a.slice(2, 4)}/${a.slice(4)}` });
    }
    const out = await git(["cat-file", "--batch"], {
      cwd: this.repo,
      input: `${specs.map((s) => s.spec).join("\n")}\n`,
    });
    let pos = 0;
    for (const { ref } of specs) {
      const nl = out.indexOf("\n", pos);
      const header = out.slice(pos, nl);
      pos = nl + 1;
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
      const size = Number(header.split(" ")[2]);
      const body = out.slice(pos, pos + size);
      pos += size + 1;
      if (!contents.has(ref)) contents.set(ref, body);
    }
    return contents;
  }

  async *scan(
    filter?: ShardFilter,
    onProblem?: (p: ParseProblem) => void
  ): AsyncIterable<MemoryRecord> {
    const refs = await this.listRefs(filter);
    const contents = await this.readAll(refs);
    for (const { ref, key } of refs) {
      const { records, problems } = parseJsonl(contents.get(ref) ?? "");
      for (const p of problems) onProblem?.({ shard: key, ...p });
      for (const r of records) yield r;
    }
  }

  async shards(filter?: ShardFilter): Promise<ShardInfo[]> {
    return (await this.listRefs(filter)).map(({ key, sha }) => ({ ...key, revision: sha }));
  }

  async health(): Promise<HealthReport> {
    const problems: string[] = [];
    const details: Record<string, unknown> = {
      repo: this.repo,
      anchor: this.anchor,
      remote: this.remote,
    };
    details.anchorPresent = await objectPresent(this.repo, this.anchor);
    const refs = await this.listRefs();
    details.shards = refs.length;
    let bad = 0;
    for await (const _ of this.scan(undefined, (p) => {
      bad += 1;
      problems.push(`${refFor(p.shard)}:${p.line} ${p.message}`);
    })) {
      // drain
    }
    details.badLines = bad;
    return { ok: problems.length === 0, problems, details };
  }

  async readDocument(name: string): Promise<StoreDocument | null> {
    assertDocumentName(name);
    const version = await this.tip(documentRef(this.level, name));
    if (!version) return null;
    const text = await readDocumentAt(this.repo, version, name);
    return text === null ? null : { text, version };
  }

  /** Version is the document ref's commit sha; `update-ref` with the old value is the CAS. */
  async writeDocument(name: string, text: string, expected: string | null): Promise<string | null> {
    assertDocumentName(name);
    const ref = documentRef(this.level, name);
    const lock = await this.lockPath();
    return withLock(
      lock,
      async () => {
        const old = await this.tip(ref);
        if (old !== expected) return null;
        const env = await this.identity();
        const commit = await commitDocument(
          this.repo,
          env,
          name,
          text,
          old ? [old] : [],
          `ynm: document ${name}`
        );
        const updated = await gitOrNull(
          ["update-ref", ref, commit, old ?? "0".repeat(commit.length)],
          { cwd: this.repo }
        );
        return updated === null ? null : commit;
      },
      LOCK_TIMEOUT_MS
    );
  }

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const lock = await this.lockPath();
    return withLock(
      lock,
      () =>
        syncDistributed({
          ...options,
          repo: this.repo,
          level: this.level,
          remote: options.remote ?? this.remote,
          env: this.identity(),
        }),
      LOCK_TIMEOUT_MS
    );
  }

  /** Rewrites each shard holding the memory; `forgetHistory` starts the ref's history afresh. */
  async purge(memoryId: string, options: { forgetHistory?: boolean } = {}): Promise<PurgeResult> {
    const lock = await this.lockPath();
    return withLock(
      lock,
      async () => {
        const env = await this.identity();
        const refs = await this.listRefs();
        const contents = await this.readAll(refs);
        let removed = 0;
        const shards: ShardKey[] = [];
        for (const { ref, key, sha } of refs) {
          const { records } = parseJsonl(contents.get(ref) ?? "");
          const kept = records.filter((r) => r.memoryId !== memoryId);
          if (kept.length === records.length) continue;
          const { others } = await this.readNote(sha);
          const blob = (
            await git(["hash-object", "-w", "--stdin"], {
              cwd: this.repo,
              input: serializeJsonl(kept),
            })
          ).trim();
          const treeLines = [
            ...others.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`),
            `100644 blob ${blob}\t${this.anchor}`,
          ];
          const tree = (
            await git(["mktree"], { cwd: this.repo, input: `${treeLines.join("\n")}\n` })
          ).trim();
          const parentArgs = options.forgetHistory ? [] : ["-p", sha];
          const message = `ynm: purge ${memoryId} from ${key.level}/${key.namespace}/${key.type}/${key.bucket}${options.forgetHistory ? " (history dropped)" : ""}`;
          const commit = (
            await git(["commit-tree", tree, ...parentArgs, "-m", message], { cwd: this.repo, env })
          ).trim();
          await git(["update-ref", ref, commit, sha], { cwd: this.repo });
          removed += records.length - kept.length;
          shards.push(key);
        }
        return { removed, shards };
      },
      LOCK_TIMEOUT_MS
    );
  }
}
