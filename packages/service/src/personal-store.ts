import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRootCommit, findRootCommit, git, identityEnv } from "@ynm/store";

export interface PersonalStore {
  repo: string;
  anchor: string;
  created: boolean;
}

/**
 * The user's own store: a bare repo with one root commit, never inside a project (ADR-007).
 * Created on first use so `ynm` works with zero configuration (NFR-14).
 */
export async function ensurePersonalStore(path: string): Promise<PersonalStore> {
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await git(["init", "-q", "--bare", "-b", "main", path], { cwd: dirname(path) });
    created = true;
  }
  let anchor = await findRootCommit(path);
  if (!anchor) {
    anchor = await createRootCommit(path, await identityEnv(path));
    created = true;
  }
  return { repo: path, anchor, created };
}
