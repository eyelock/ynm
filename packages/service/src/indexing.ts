import { join } from "node:path";
import {
  type IndexedMemory,
  InMemoryIndex,
  type MemoryIndex,
  SqliteIndex,
  toIndexed,
} from "@ynm/index";
import type { MemoryRecord } from "@ynm/model";
import { type AppendResult, applyRecord, fold, memoryFromBase, shardId } from "@ynm/store";
import type { Mount } from "./mounts.js";

export type IndexProvider = "sqlite-fts" | "memory";

export interface IndexLocator {
  /** Where a mount's index file lives; ignored for the memory provider. */
  fileFor(mount: Mount): string;
}

export function defaultIndexLocator(home: string, repo?: string): IndexLocator {
  return {
    fileFor(mount) {
      if (mount.id === "project" && repo) return join(repo, ".ynm", "index", "project.sqlite");
      return join(home, "index", `${mount.id}.sqlite`);
    },
  };
}

export interface FreshnessReport {
  mount: string;
  fresh: boolean;
  indexed: number;
  reason?: string;
}

/**
 * One index per mount (ADR-005). Freshness is decided by comparing the log's shard revisions
 * with the ones the index recorded; a difference rebuilds from a full scan. A writer in this
 * process updates the index exactly by applying its new record to the stored folded state.
 */
export class IndexManager {
  private readonly open = new Map<string, MemoryIndex>();

  constructor(
    readonly provider: IndexProvider,
    readonly locator: IndexLocator
  ) {}

  async indexFor(mount: Mount): Promise<MemoryIndex> {
    let ix = this.open.get(mount.id);
    if (!ix) {
      ix =
        this.provider === "memory"
          ? new InMemoryIndex()
          : new SqliteIndex(this.locator.fileFor(mount));
      await ix.open();
      this.open.set(mount.id, ix);
    }
    return ix;
  }

  async close(): Promise<void> {
    for (const ix of this.open.values()) await ix.close();
    this.open.clear();
  }

  private async currentRevisions(mount: Mount): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const s of await mount.log.shards()) out[shardId(s)] = s.revision;
    return out;
  }

  async rebuild(mount: Mount): Promise<number> {
    const ix = await this.indexFor(mount);
    const revisions = await this.currentRevisions(mount);
    const records: MemoryRecord[] = [];
    for await (const r of mount.log.scan()) records.push(r);
    const { memories } = fold(records);
    const docs: IndexedMemory[] = [];
    for (const m of memories.values()) docs.push(toIndexed(mount.id, m));
    await ix.rebuild(docs, revisions);
    return docs.length;
  }

  async freshness(mount: Mount): Promise<FreshnessReport> {
    const ix = await this.indexFor(mount);
    const [current, seen] = await Promise.all([this.currentRevisions(mount), ix.revisions()]);
    const currentKeys = Object.keys(current);
    const seenKeys = Object.keys(seen);
    let reason: string | undefined;
    if (currentKeys.length !== seenKeys.length)
      reason = `${currentKeys.length} shards in log, ${seenKeys.length} indexed`;
    else {
      const changed = currentKeys.find((k) => current[k] !== seen[k]);
      if (changed) reason = `shard ${changed} changed`;
    }
    return { mount: mount.id, fresh: !reason, indexed: await ix.count(), reason };
  }

  /** Rebuilds when stale; cheap when fresh (one shard listing plus one small query). */
  async ensureFresh(mount: Mount): Promise<MemoryIndex> {
    const f = await this.freshness(mount);
    if (!f.fresh) await this.rebuild(mount);
    return this.indexFor(mount);
  }

  /**
   * Exact incremental update after this process appended `record`. If another writer touched the
   * shard since the index last saw it, the shard's revision is dropped so the next read rebuilds.
   */
  async afterWrite(mount: Mount, record: MemoryRecord, result: AppendResult): Promise<void> {
    const ix = await this.indexFor(mount);
    const seen = await ix.revisions();
    let stale = false;
    for (const s of result.shards) {
      const id = shardId(s.key);
      const before = seen[id];
      if (before !== undefined && before !== s.previous) stale = true;
      if (before === undefined && s.previous !== null) stale = true;
      seen[id] = s.revision;
    }
    if (record.op === "create") {
      await ix.upsert([toIndexed(mount.id, memoryFromBase(record))]);
    } else {
      const prior = (await ix.get([record.memoryId])).get(record.memoryId)?.state;
      if (prior) {
        const next = structuredClone(prior);
        applyRecord(next, record);
        await ix.upsert([toIndexed(mount.id, next)]);
      } else {
        stale = true;
      }
    }
    if (stale) {
      for (const s of result.shards) delete seen[shardId(s.key)];
    }
    await ix.setRevisions(seen);
  }
}
