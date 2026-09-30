import type { Level } from "@ynm/model";
import type { SyncResult } from "../../log.js";
import { git, gitOrNull } from "./git.js";
import { levelDir, NOTES_PREFIX, REMOTE_PREFIX } from "./refs.js";

export interface SyncParams {
  repo: string;
  level: Level;
  remote: string;
  env: Promise<NodeJS.ProcessEnv>;
  push?: boolean;
  pull?: boolean;
  dryRun?: boolean;
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
 * Fetch into a remote-tracking namespace (never forced into the working refs), fast-forward or
 * `notes merge -s cat_sort_uniq`, push, retry on rejection (ADR-003, ADR-007).
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
      `remote "${p.remote}" is not configured; add it and run \`ynm init\` again`
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

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (doPull) {
      // The remote may have no notes at all yet; an empty refspec match is not an error we care about.
      await gitOrNull(["fetch", "--quiet", target, `+${local}*:${tracking}*`], {
        cwd: p.repo,
        env,
      });
      const remoteRefs = await listRefs(p.repo, tracking);
      const localRefs = await listRefs(p.repo, local);
      result.fetched = remoteRefs.size;
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
    try {
      await git(["push", "--quiet", target, `${local}*:${local}*`], { cwd: p.repo, env });
      result.pushed = [...(await listRefs(p.repo, local)).keys()];
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
