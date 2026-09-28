import { assertSha, git, gitOrNull } from "./git.js";

export interface AnchorSelection {
  sha: string;
  /** How it was chosen; the doctor reports this. */
  source: "config" | "root-commit" | "created";
  /** True when the object is not present locally (shallow clone); plumbing still works. */
  present: boolean;
}

export async function isShallow(cwd: string): Promise<boolean> {
  return (await gitOrNull(["rev-parse", "--is-shallow-repository"], { cwd }))?.trim() === "true";
}

export async function hasCommits(cwd: string): Promise<boolean> {
  return (await gitOrNull(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd })) !== null;
}

export async function objectPresent(cwd: string, sha: string): Promise<boolean> {
  return (await gitOrNull(["cat-file", "-e", `${sha}^{commit}`], { cwd })) !== null;
}

/**
 * The oldest root commit by committer date, ties broken by the smaller sha (ADR-003). Notes refs
 * are excluded: every notes history starts with a parentless commit and must never be mistaken
 * for the repository's root. Root commits of a shallow clone are graft points, not real roots,
 * so callers must pass the configured anchor for shallow repos.
 */
export async function findRootCommit(cwd: string): Promise<string | null> {
  const out = await gitOrNull(
    [
      "rev-list",
      "--max-parents=0",
      "--exclude=refs/notes/*",
      "--exclude=refs/ynm-remote/*",
      "--all",
      "--format=%H %ct",
    ],
    { cwd }
  );
  if (!out) return null;
  const roots = out
    .split("\n")
    .filter((l) => /^[0-9a-f]{40,64} \d+$/.test(l))
    .map((l) => {
      const [sha, ct] = l.split(" ");
      return { sha: sha as string, ct: Number(ct) };
    });
  if (roots.length === 0) return null;
  roots.sort((a, b) => a.ct - b.ct || (a.sha < b.sha ? -1 : 1));
  return roots[0]?.sha ?? null;
}

/** Creates an empty root commit on the current branch of a repo that has none. */
export async function createRootCommit(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const tree = (await git(["mktree"], { cwd, input: "" })).trim();
  const commit = (await git(["commit-tree", tree, "-m", "ynm: root"], { cwd, env })).trim();
  const head =
    (await gitOrNull(["symbolic-ref", "-q", "HEAD"], { cwd }))?.trim() || "refs/heads/main";
  await git(["update-ref", head, commit], { cwd });
  return commit;
}

/**
 * Resolves the anchor: configured sha wins; otherwise the root commit; otherwise, if allowed,
 * a fresh root commit is created.
 */
export async function selectAnchor(
  cwd: string,
  options: { configured?: string; create?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<AnchorSelection> {
  if (options.configured) {
    assertSha(options.configured);
    return {
      sha: options.configured,
      source: "config",
      present: await objectPresent(cwd, options.configured),
    };
  }
  if (await isShallow(cwd)) {
    throw new Error(
      "shallow clone: the root commit cannot be determined; set `anchor` in .ynm/config.json (from a full clone) or run `git fetch --unshallow`"
    );
  }
  const root = await findRootCommit(cwd);
  if (root) return { sha: root, source: "root-commit", present: true };
  if (!options.create)
    throw new Error("repository has no commits; run `ynm init` to create the root commit");
  const created = await createRootCommit(cwd, options.env ?? {});
  return { sha: created, source: "created", present: true };
}
