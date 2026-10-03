import type { Level } from "@ynm/model";
import type { SyncOptions, SyncResult } from "../../log.js";
import { commitDocument, readDocumentAt } from "./documents.js";
import { git, gitOrNull } from "./git.js";
import {
  distributedFetchRefspec,
  documentPrefix,
  documentTrackingPrefix,
  levelDir,
  NOTES_PREFIX,
  REMOTE_PREFIX,
} from "./refs.js";

export interface SyncParams {
  repo: string;
  level: Level;
  remote: string;
  env: Promise<NodeJS.ProcessEnv>;
  push?: boolean;
  pull?: boolean;
  dryRun?: boolean;
  mergeDocuments?: SyncOptions["mergeDocuments"];
}

const MAX_ROUNDS = 3;

async function listRefs(repo: string, prefix: string): Promise<Map<string, string>> {
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], {
    cwd: repo,
  });
  const map = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ");
    if (ref && sha) map.set(ref, sha);
  }
  return map;
}

async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  return (await gitOrNull(["merge-base", "--is-ancestor", a, b], { cwd: repo })) !== null;
}

/**
 * Reconciles fetched documents with the local ones: create, fast-forward, or for a document
 * changed on both sides, a two-parent commit of the named merger's output so the push
 * fast-forwards. With no merger the local copy stays and the document is a conflict.
 * Returns the names left in conflict, which the push must skip.
 */
async function reconcileDocuments(
  p: SyncParams,
  env: NodeJS.ProcessEnv,
  result: SyncResult
): Promise<Set<string>> {
  const local = documentPrefix(p.level);
  const tracking = documentTrackingPrefix(p.remote, p.level);
  const remoteRefs = await listRefs(p.repo, tracking);
  const localRefs = await listRefs(p.repo, local);
  const conflicted = new Set<string>();
  result.fetched += remoteRefs.size;
  for (const [rref, rsha] of remoteRefs) {
    const name = rref.slice(tracking.length);
    const label = `documents/${name}`;
    const lref = local + name;
    const lsha = localRefs.get(lref);
    if (lsha === rsha) continue;
    if (p.dryRun) {
      result.merged.push(label);
      continue;
    }
    if (!lsha || (await isAncestor(p.repo, lsha, rsha))) {
      await git(["update-ref", lref, rsha, lsha ?? "0".repeat(rsha.length)], { cwd: p.repo });
      result.merged.push(label);
      continue;
    }
    if (await isAncestor(p.repo, rsha, lsha)) continue;
    const merger = p.mergeDocuments?.[name];
    if (!merger) {
      conflicted.add(name);
      if (!result.conflicts.includes(label)) result.conflicts.push(label);
      continue;
    }
    const ours = (await readDocumentAt(p.repo, lsha, name)) ?? "";
    const theirs = (await readDocumentAt(p.repo, rsha, name)) ?? "";
    const commit = await commitDocument(
      p.repo,
      env,
      name,
      merger(ours, theirs),
      [lsha, rsha],
      `ynm: merge document ${name}`
    );
    await git(["update-ref", lref, commit, lsha], { cwd: p.repo });
    result.merged.push(label);
  }
  return conflicted;
}

/** Local document refs to push: every one except those left diverged by a conflict. */
async function pushableDocuments(p: SyncParams, conflicted: Set<string>): Promise<string[]> {
  const prefix = documentPrefix(p.level);
  return [...(await listRefs(p.repo, prefix)).keys()].filter(
    (ref) => !conflicted.has(ref.slice(prefix.length))
  );
}

/**
 * Fetch into a remote-tracking namespace (never forced into the working refs), fast-forward or
 * `notes merge -s cat_sort_uniq`, push, retry on rejection (ADR-003, ADR-007). Named documents
 * ride along on their own refs and are reconciled by `reconcileDocuments`.
 */
export async function syncDistributed(p: SyncParams): Promise<SyncResult> {
  const dir = levelDir(p.level);
  const local = `${NOTES_PREFIX}/${dir}/`;
  const tracking = `${REMOTE_PREFIX}/${p.remote}/${dir}/`;
  const result: SyncResult = { fetched: 0, merged: [], pushed: [], conflicts: [], retries: 0 };
  // Marks git calls made by sync so an installed pre-push hook does not re-enter sync.
  const env = { ...(await p.env), YNM_SYNC_IN_PROGRESS: "1" };
  const doPull = p.pull ?? true;
  const doPush = p.push ?? true;
  const remoteUrl = (await gitOrNull(["remote", "get-url", p.remote], { cwd: p.repo }))?.trim();
  if (!remoteUrl) {
    result.skipped = `remote "${p.remote}" not configured; nothing to sync`;
    result.conflicts.push(
      `remote "${p.remote}" is not configured; add it with \`git remote add ${p.remote} <url>\` and sync again`
    );
    return result;
  }

  // A remote configured by `clone --mirror` (`remote.<r>.mirror = true`) refuses explicit push
  // refspecs, and its `+refs/*:refs/*` fetch refspec would also overwrite our working refs and
  // push stale branches. Talk to its URL instead, so only the notes refspecs below apply.
  const mirror =
    (
      await gitOrNull(["config", "--type=bool", "--get", `remote.${p.remote}.mirror`], {
        cwd: p.repo,
      })
    )?.trim() === "true";
  const target = mirror ? remoteUrl : p.remote;

  // A remote added after `ynm init` has no fetch line for memory yet; add it here so nobody has
  // to re-run init. Sync itself fetches explicitly and does not depend on it.
  if (p.level === "distributed" && !mirror && !p.dryRun) {
    const fetchSpec = distributedFetchRefspec(p.remote);
    const fetches =
      (await gitOrNull(["config", "--get-all", `remote.${p.remote}.fetch`], { cwd: p.repo })) ?? "";
    if (!fetches.split("\n").includes(fetchSpec)) {
      await git(["config", "--add", `remote.${p.remote}.fetch`, fetchSpec], { cwd: p.repo });
      result.refspecAdded = fetchSpec;
    }
  }

  let conflicted = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (doPull) {
      // The remote may have no notes at all yet; an empty refspec match is not an error we care about.
      // Documents are fetched with an explicit refspec only; no config line is added for them.
      await gitOrNull(
        [
          "fetch",
          "--quiet",
          target,
          `+${local}*:${tracking}*`,
          `+${documentPrefix(p.level)}*:${documentTrackingPrefix(p.remote, p.level)}*`,
        ],
        { cwd: p.repo, env }
      );
      const remoteRefs = await listRefs(p.repo, tracking);
      const localRefs = await listRefs(p.repo, local);
      result.fetched = remoteRefs.size;
      conflicted = await reconcileDocuments(p, env, result);
      for (const [rref, rsha] of remoteRefs) {
        const lref = local + rref.slice(tracking.length);
        const lsha = localRefs.get(lref);
        if (lsha === rsha) continue;
        if (p.dryRun) {
          result.merged.push(lref);
          continue;
        }
        if (!lsha || (await isAncestor(p.repo, lsha, rsha))) {
          await git(["update-ref", lref, rsha, lsha ?? "0".repeat(rsha.length)], { cwd: p.repo });
          result.merged.push(lref);
          continue;
        }
        if (await isAncestor(p.repo, rsha, lsha)) continue;
        try {
          await git(["notes", `--ref=${lref}`, "merge", "-s", "cat_sort_uniq", rref], {
            cwd: p.repo,
            env,
          });
          result.merged.push(lref);
        } catch (err) {
          await gitOrNull(["notes", `--ref=${lref}`, "merge", "--abort"], { cwd: p.repo });
          result.conflicts.push(`${lref}: ${(err as Error).message}`);
        }
      }
    }
    if (!doPush || p.dryRun) return result;
    const notes = [...(await listRefs(p.repo, local)).keys()];
    const documents = await pushableDocuments(p, conflicted);
    // Nothing written at this level yet: git rejects a push pattern that matches no refs.
    if (notes.length === 0 && documents.length === 0) return result;
    const refspecs = [
      ...(notes.length > 0 ? [`${local}*:${local}*`] : []),
      ...documents.map((ref) => `${ref}:${ref}`),
    ];
    try {
      await git(["push", "--quiet", target, ...refspecs], { cwd: p.repo, env });
      result.pushed = [...notes, ...documents];
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      if (!/rejected|fetch first|non-fast-forward|failed to push/i.test(msg)) throw err;
      result.retries += 1;
    }
  }
  result.conflicts.push(`push to ${p.remote} still rejected after ${MAX_ROUNDS} rounds`);
  return result;
}
