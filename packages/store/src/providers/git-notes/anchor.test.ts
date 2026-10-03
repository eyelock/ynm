import { createRepo, fx, rootCommit } from "../../testing/git-fixtures.js";
import { createRootCommit, findRootCommit, hasCommits, isShallow, selectAnchor } from "./anchor.js";
import { git } from "./git.js";

const SAME_DATE = {
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
};
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

async function orphanRoot(repo: string, branch: string): Promise<string> {
  await fx(repo, "checkout", "-q", "--orphan", branch);
  await git(["commit", "-q", "--allow-empty", "-m", branch], {
    cwd: repo,
    env: { ...IDENTITY, ...SAME_DATE },
  });
  return fx(repo, "rev-parse", "HEAD");
}

describe("hasCommits and isShallow", () => {
  it("reports whether HEAD resolves to a commit", async () => {
    expect(await hasCommits(await createRepo(0))).toBe(false);
    expect(await hasCommits(await createRepo(1))).toBe(true);
  });
  it("reports a full clone as not shallow", async () => {
    expect(await isShallow(await createRepo(1))).toBe(false);
  });
});

describe("findRootCommit", () => {
  it("returns null for a repo with no commits", async () => {
    expect(await findRootCommit(await createRepo(0))).toBeNull();
  });

  it("breaks a committer-date tie between roots by the smallest sha", async () => {
    const repo = await createRepo(0);
    const roots = [
      await orphanRoot(repo, "r1"),
      await orphanRoot(repo, "r2"),
      await orphanRoot(repo, "r3"),
    ];
    expect(new Set(roots).size).toBe(3);
    expect(await findRootCommit(repo)).toBe([...roots].sort()[0]);
  });
});

describe("findRootCommit and documents", () => {
  it("never mistakes an older document commit for the root", async () => {
    const repo = await createRepo(1);
    const root = await rootCommit(repo);
    // A parentless document commit dated before the real root would win if it were counted.
    const blob = (await git(["hash-object", "-w", "--stdin"], { cwd: repo, input: "{}" })).trim();
    const tree = (
      await git(["mktree"], { cwd: repo, input: `100644 blob ${blob}\tpeople.json\n` })
    ).trim();
    const doc = (
      await git(["commit-tree", tree, "-m", "ynm: document people"], {
        cwd: repo,
        env: { ...IDENTITY, GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
      })
    ).trim();
    await fx(repo, "update-ref", "refs/ynm/distributed/documents/people", doc);
    await fx(repo, "update-ref", "refs/ynm-remote/origin/distributed/documents/people", doc);
    expect(await findRootCommit(repo)).toBe(root);
  });
});

describe("createRootCommit", () => {
  it("moves main when HEAD is detached", async () => {
    const repo = await createRepo(2);
    const before = await fx(repo, "rev-parse", "HEAD");
    await fx(repo, "checkout", "-q", "--detach");
    const created = await createRootCommit(repo, IDENTITY);
    expect(await fx(repo, "rev-parse", "refs/heads/main")).toBe(created);
    expect(await fx(repo, "rev-list", "--count", created)).toBe("1");
    // Detached HEAD itself is left where it was.
    expect(await fx(repo, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("selectAnchor", () => {
  it("rejects a configured anchor that is not an object id", async () => {
    const repo = await createRepo(1);
    await expect(selectAnchor(repo, { configured: "HEAD" })).rejects.toThrow(/not an object id/);
  });

  it("marks a configured anchor missing locally as not present", async () => {
    const repo = await createRepo(1);
    const sel = await selectAnchor(repo, { configured: "0".repeat(40) });
    expect(sel).toEqual({ sha: "0".repeat(40), source: "config", present: false });
  });

  it("creates a root commit without an explicit env when the repo has an identity", async () => {
    const repo = await createRepo(0);
    await fx(repo, "config", "user.name", "t");
    await fx(repo, "config", "user.email", "t@t");
    const sel = await selectAnchor(repo, { create: true });
    expect(sel).toMatchObject({ source: "created", present: true });
    expect(await rootCommit(repo)).toBe(sel.sha);
  });
});
